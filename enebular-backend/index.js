const { CloudDataStoreClient } = require("@uhuru/enebular-sdk");

// Initialize the enebular CloudDataStoreClient
const datastore = new CloudDataStoreClient();

/**
 * enebular Cloud Execution Environment Handler
 * (Receives standard AWS API Gateway Lambda Proxy integration events)
 */
exports.handler = async (event) => {
  console.log("Received event:", JSON.stringify(event, null, 2));

  // 1. API Key Authentication (Optional security verification)
  const expectedApiKey = process.env.DEVICE_API_KEY;
  if (expectedApiKey) {
    const headers = event.headers || {};
    // Extract x-api-key header in a case-insensitive manner
    const apiKey = headers["x-api-key"] || headers["X-Api-Key"];
    if (apiKey !== expectedApiKey) {
      console.warn("Authentication failed: API key mismatch.");
      return {
        statusCode: 401,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Unauthorized" }),
      };
    }
  }

  // 2. Parse request payload
  let body = event.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch (err) {
      console.error("Failed to parse request body as JSON:", err);
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Invalid JSON body" }),
      };
    }
  }

  // Support both JSON Array and single JSON Object (convert single to Array)
  const records = Array.isArray(body) ? body : (body ? [body] : []);
  if (records.length === 0) {
    console.warn("Bad Request: Empty or invalid payload.");
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Empty or invalid payload" }),
    };
  }

  // Validate required fields in the records
  for (const rec of records) {
    const { weight_g, consumed_ml, temp_c, humi_pct, press_hpa } = rec;
    if (
      weight_g === undefined ||
      consumed_ml === undefined ||
      temp_c === undefined ||
      humi_pct === undefined ||
      press_hpa === undefined
    ) {
      console.warn("Bad Request: Missing required sensor fields in one or more records.");
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Missing required fields in one or more records" }),
      };
    }
  }

  // Sort records in chronological order (oldest first).
  // offset_sec represents how many seconds ago the data was recorded, so larger offset_sec means older.
  records.sort((a, b) => {
    const offsetA = a.offset_sec !== undefined ? a.offset_sec : 0;
    const offsetB = b.offset_sec !== undefined ? b.offset_sec : 0;
    return offsetB - offsetA; // Descending order of offset_sec = chronological order (oldest first)
  });

  // 3. Retrieve initial previous pressure value from enebular Datastore
  let lastPressure = null;
  const tableId = process.env.TABLE_ID;

  if (tableId) {
    try {
      // Query the latest database item for this device (partition key: deviceId)
      const queryResult = await datastore.query({
        tableId: tableId,
        expression: "#deviceId = :deviceId",
        values: { deviceId: "komame-coaster" },
        order: false, // Descending order (latest record first)
        limit: 1,
      });

      const items =
        (queryResult && queryResult.params && queryResult.params.Items) ||
        (queryResult && queryResult.Items) ||
        [];

      if (items.length > 0) {
        lastPressure = items[0].press_hpa;
        console.log(`Initial previous pressure from Datastore: ${lastPressure} hPa`);
      } else {
        console.log("No previous records found in Datastore. Setting initial Delta P = 0.0 hPa");
      }
    } catch (err) {
      console.error("Failed to query previous records from Datastore:", err);
    }
  } else {
    console.warn("TABLE_ID environment variable is not defined. Datastore operations skipped.");
  }

  // 4. Process each record sequentially (chronological order)
  const baseTime = Date.now();
  const processedRecords = [];

  for (const rec of records) {
    const { weight_g, consumed_ml, temp_c, humi_pct, press_hpa, offset_sec } = rec;

    // Restore absolute timestamp
    const offset = offset_sec !== undefined ? offset_sec : 0;
    const timestamp = baseTime - (offset * 1000);

    // Calculate WBGT (Japanese meteorology simple estimation formula)
    const wbgt = 0.725 * temp_c + 0.0368 * humi_pct + 0.00364 * (temp_c * humi_pct) - 3.246;

    // Calculate sequential Delta P
    let dP = 0.0;
    if (lastPressure !== null) {
      dP = press_hpa - lastPressure;
    }
    // Update lastPressure to current for the next element in sequence
    lastPressure = press_hpa;

    processedRecords.push({
      deviceId: "komame-coaster",
      timestamp: timestamp,
      weight_g: weight_g,
      consumed_ml: consumed_ml,
      temp_c: temp_c,
      humi_pct: humi_pct,
      press_hpa: press_hpa,
      wbgt: parseFloat(wbgt.toFixed(2)),
      dP: parseFloat(dP.toFixed(2)),
    });
  }

  // 5. Store all readings to enebular Datastore in parallel
  if (tableId) {
    try {
      await Promise.all(
        processedRecords.map((item) =>
          datastore.putItem({
            tableId: tableId,
            item: item,
          })
        )
      );
      console.log(`Saved ${processedRecords.length} readings to Datastore successfully.`);
    } catch (err) {
      console.error("Failed to save readings to Datastore:", err);
    }
  }

  // 6. Check alert triggers & aggregate results
  let isHeatRisk = false;
  let isPressureDrop = false;
  let totalConsumed = 0;

  let maxWbgt = -999;
  let minDP = 999; // Lower dP is more critical (negative drops)

  for (const item of processedRecords) {
    if (item.wbgt >= 28.0) isHeatRisk = true;
    if (item.dP <= -1.5) isPressureDrop = true;
    if (item.consumed_ml > 0) totalConsumed += item.consumed_ml;

    if (item.wbgt > maxWbgt) maxWbgt = item.wbgt;
    if (item.dP < minDP) minDP = item.dP;
  }

  if (maxWbgt === -999) maxWbgt = 0.0;
  if (minDP === 999) minDP = 0.0;

  const didDrink = totalConsumed > 0;

  // Use the latest record's parameters for environmental context in notifications
  const latestRecord = processedRecords[processedRecords.length - 1] || {};
  const currentWbgt = latestRecord.wbgt !== undefined ? latestRecord.wbgt : maxWbgt;
  const currentDP = latestRecord.dP !== undefined ? latestRecord.dP : minDP;

  if (isHeatRisk || isPressureDrop || didDrink) {
    const lineToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
    const lineUserId = process.env.LINE_USER_ID;
    const geminiApiKey = process.env.GEMINI_API_KEY;

    if (lineToken && lineUserId && geminiApiKey) {
      try {
        // Build dynamic context prompt for Google Gemini
        const systemPrompt = `あなたはM5Atom S3のスマートコースターに宿っている、お水飲み見守りキャラクターの「こまめちゃん」です。
ユーザーを大切に想う、少しお節介で人懐っこい口調（語尾に「〜だよ」「〜ね！」を使用）で語りかけてください。

現在のお部屋のコンテキストを分析してください：
- 最新の簡易暑さ指数(WBGT): ${currentWbgt.toFixed(1)} (28以上は熱中症危険)
- 直近の気圧変化量 (最小値): ${currentDP.toFixed(1)} hPa (マイナス1.5hPa以下の低下は気象病・低気圧頭痛に警戒)
- 今回検出された合計水分補給量: ${totalConsumed.toFixed(1)} ml

【命令・ルール】
1. 数値情報をそのまま伝えるのではなく、体感やこまめちゃんの気分・心配事に翻訳して伝えてください。
2. 熱中症リスクや、気圧低下による水分バランスの乱れ（水毒・自律神経の乱れ・脱水による血液の滞り）に合わせたアドバイスをしてください。特に低気圧時は「がぶ飲み」ではなく「ノンカフェインのドリンクをこまめにちびちび飲む」ことが推奨される医学的な理由を、優しくかみ砕いて説明してください。
3. 水, お茶, スポーツドリンク, ジュース, コーヒーなど、あらゆる飲み物に対応した親しみやすい表現にし、白湯に限定しないでください。
4. LINE用のチャットメッセージとして150文字以内で作成してください。`;

        const userMessage = "アドバイスを作ってね！";

        console.log("Requesting Gemini message generation...");
        // Request Gemini API to generate the custom message (using native fetch)
        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key=${geminiApiKey}`;
        const geminiResponse = await fetch(geminiUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            system_instruction: {
              parts: [{ text: systemPrompt }],
            },
            contents: [
              {
                role: "user",
                parts: [{ text: userMessage }],
              },
            ],
          }),
        });

        if (!geminiResponse.ok) {
          throw new Error(`Gemini API returned status ${geminiResponse.status}: ${await geminiResponse.text()}`);
        }

        const geminiData = await geminiResponse.json();
        const textMessage =
          geminiData.candidates &&
          geminiData.candidates[0] &&
          geminiData.candidates[0].content &&
          geminiData.candidates[0].content.parts &&
          geminiData.candidates[0].content.parts[0] &&
          geminiData.candidates[0].content.parts[0].text;

        if (textMessage) {
          const formattedText = textMessage.trim();
          console.log("Gemini generated text:", formattedText);

          // Call LINE Messaging API to send push notification (using native fetch)
          const lineUrl = "https://api.line.me/v2/bot/message/push";
          const lineResponse = await fetch(lineUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${lineToken}`,
            },
            body: JSON.stringify({
              to: lineUserId,
              messages: [
                {
                  type: "text",
                  text: formattedText,
                },
              ],
            }),
          });

          if (!lineResponse.ok) {
            throw new Error(`LINE API returned status ${lineResponse.status}: ${await lineResponse.text()}`);
          }
          console.log("LINE push notification sent successfully.");
        } else {
          console.warn("Gemini API did not return candidates or text.");
        }
      } catch (err) {
        console.error("Failed to generate or send LINE notification:", err);
      }
    } else {
      console.warn("Missing LINE_CHANNEL_ACCESS_TOKEN, LINE_USER_ID, or GEMINI_API_KEY environment variables. Notification skipped.");
    }
  }

  // Return success response to the coaster client
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: `Successfully processed ${processedRecords.length} records`,
      latestWbgt: parseFloat(currentWbgt.toFixed(2)),
      latestDP: parseFloat(currentDP.toFixed(2)),
      totalConsumed: parseFloat(totalConsumed.toFixed(2)),
    }),
  };
};
