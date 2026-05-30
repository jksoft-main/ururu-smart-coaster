const { CloudDataStoreClient } = require("@uhuru/enebular-sdk");

// Initialize the enebular CloudDataStoreClient
const datastore = new CloudDataStoreClient();

/**
 * enebular Cloud Execution Environment Handler
 * (Receives standard AWS API Gateway Lambda Proxy integration events)
 */
exports.handler = async (event) => {
  console.log("Received event:", JSON.stringify(event, null, 2));

  // 1. Parse request payload first to inspect the request source
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

  // Detect if this is a LINE Webhook event (contains a destination and events array)
  const isLineWebhook = body && Array.isArray(body.events);

  if (!isLineWebhook) {
    // 2. API Key Authentication (Optional security verification for smart coaster device uploads)
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
  }

  // 3. Handle LINE Webhook events (User querying "こまめちゃん" chatbot)
  if (isLineWebhook) {
    const lineToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
    const geminiApiKey = process.env.GEMINI_API_KEY;
    const tableId = process.env.TABLE_ID;

    for (const lineEvent of body.events) {
      if (lineEvent.type === "message" && lineEvent.message && lineEvent.message.type === "text") {
        const replyToken = lineEvent.replyToken;
        const userText = lineEvent.message.text.trim();
        console.log(`Received message from user: "${userText}"`);

        // Check for inquiry keywords (environment, temperature, etc.) to trigger response
        const keywords = ["環境", "状態", "部屋", "温度", "室温", "湿度", "気圧", "wbgt", "熱中症", "調子", "元気", "ステータス", "天気", "暑い", "寒い", "こmadaよ", "こまだよ", "こまめ"];
        const matched = keywords.some(kw => userText.includes(kw));

        if (!matched) {
          console.log("No keywords matched. Skipping reply.");
          continue;
        }

        // Query the datastore for the latest room status record
        let latestRecord = null;
        if (tableId) {
          try {
            const queryResult = await datastore.query({
              tableId: tableId,
              expression: "#deviceId = :deviceId",
              values: { deviceId: "komame-coaster" },
              order: false, // Descending order (latest first)
              limit: 10,
            });

            const items =
              (queryResult && queryResult.params && queryResult.params.Items) ||
              (queryResult && queryResult.Items) ||
              [];

            for (const item of items) {
              if (item.press_hpa !== undefined) {
                latestRecord = item;
                break;
              }
            }
          } catch (err) {
            console.error("Failed to query datastore for LINE reply:", err);
          }
        }

        let replyText = "";
        if (latestRecord) {
          const currentTemp = latestRecord.temp_c;
          const currentHumi = latestRecord.humi_pct;
          const currentPress = latestRecord.press_hpa;
          const currentWbgt = latestRecord.wbgt;
          const currentDP = latestRecord.dP;
          const currentWeight = latestRecord.weight_g;
          const isCupPresent = currentWeight > 15.0;

          if (geminiApiKey) {
            try {
              const systemPrompt = `あなたはM5Atom S3のスマートコースターに宿っている、お水飲み見守りキャラクターの「こまめちゃん」です。
ユーザーを大切に想う、少しお節介で人懐っこい口調（語尾に「〜だよ」「〜ね！」を使用）で語りかけてください。

現在のお部屋のコンテキスト：
- 室温: ${currentTemp.toFixed(1)} ℃
- 湿度: ${currentHumi.toFixed(0)} %
- 気圧: ${currentPress.toFixed(1)} hPa (直近の変化: ${currentDP.toFixed(1)} hPa)
- 簡易暑さ指数(WBGT): ${currentWbgt.toFixed(1)} (28以上は熱中症危険)
- コースターの状態: ${isCupPresent ? `コップが置いてあるよ（重さ: ${currentWeight.toFixed(0)}g）` : "コップは置いてないみたい"}

ユーザーからのメッセージ: "${userText}"

【命令・ルール】
1. ユーザーからのメッセージに対して、現在のお部屋の環境コンテキストを踏まえて優しく回答してください。
2. もし暑さ指数（WBGT）が高い場合や、気圧が急激に下がっている場合は、水分補給を優しく促したり体調を気遣ってください。
3. LINE用のチャットメッセージとして150文字以内で作成してください。`;

              const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiApiKey}`;
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
                      parts: [{ text: "状況を教えて！" }],
                    },
                  ],
                }),
              });

              if (geminiResponse.ok) {
                const geminiData = await geminiResponse.json();
                const textMessage =
                  geminiData.candidates &&
                  geminiData.candidates[0] &&
                  geminiData.candidates[0].content &&
                  geminiData.candidates[0].content.parts &&
                  geminiData.candidates[0].content.parts[0] &&
                  geminiData.candidates[0].content.parts[0].text;

                if (textMessage) {
                  replyText = textMessage.trim();
                  console.log("Gemini generated chatbot reply:", replyText);
                }
              }
            } catch (geminiErr) {
              console.error("Gemini failed for LINE reply, falling back to static:", geminiErr);
            }
          }

          if (!replyText) {
            replyText = `こまだよ！今のお部屋は、気温: ${currentTemp.toFixed(1)}℃、湿度: ${currentHumi.toFixed(0)}%、気圧: ${currentPress.toFixed(1)}hPaだよ！水分補給をこまめにしようね！`;
          }
        } else {
          replyText = "こまだよ！まだコースターのデータが見つからないみたい。電源が入っているか確認してね！";
        }

        if (lineToken) {
          try {
            const lineUrl = "https://api.line.me/v2/bot/message/reply";
            const lineResponse = await fetch(lineUrl, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${lineToken}`,
              },
              body: JSON.stringify({
                replyToken: replyToken,
                messages: [
                  {
                    type: "text",
                    text: replyText,
                  },
                ],
              }),
            });

            if (!lineResponse.ok) {
              console.error(`Failed to send LINE reply: ${await lineResponse.text()}`);
            } else {
              console.log("LINE reply sent successfully.");
            }
          } catch (lineErr) {
            console.error("Failed to send LINE reply:", lineErr);
          }
        }
      }
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Webhook processed" }),
    };
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

  // 3. Retrieve recent records from enebular Datastore for pressure + hydration reminder
  const baseTime = Date.now();
  const firstRecordOffset = records[0] && records[0].offset_sec !== undefined ? records[0].offset_sec : 0;
  const firstRecordTimestamp = baseTime - (firstRecordOffset * 1000);

  let lastPressure = null;
  let lastDrinkTime = null;
  let reminderAlreadySent = false;
  let lastDrinkNotificationTime = null;
  let sessionStartTime = firstRecordTimestamp; // Default to oldest current record timestamp if no history
  let boundaryFound = false;

  // Calculate the total consumed volume in the current batch
  let currentBatchConsumed = 0;
  for (const rec of records) {
    if (rec.consumed_ml > 0) {
      currentBatchConsumed += rec.consumed_ml;
    }
  }
  // Initialize the cumulative consumed volume since the last notification
  let consumedSinceLastNotification = currentBatchConsumed;

  const tableId = process.env.TABLE_ID;
  const REMINDER_THRESHOLD_MS = 60 * 60 * 1000; // 60 minutes
  const DRINK_NOTIFICATION_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

  if (tableId) {
    try {
      // Query recent records (up to 100 = ~8 hours of 5-min intervals) for pressure and hydration tracking
      // Note: order: false maps to descending (latest first) in the enebular SDK proxy payload
      const queryResult = await datastore.query({
        tableId: tableId,
        expression: "#deviceId = :deviceId",
        values: { deviceId: "komame-coaster" },
        order: false,
        limit: 100,
      });

      const items =
        (queryResult && queryResult.params && queryResult.params.Items) ||
        (queryResult && queryResult.Items) ||
        [];

      if (items.length > 0) {
        // Find the most recent record with press_hpa for delta-P calculation
        for (const item of items) {
          if (item.press_hpa !== undefined && item.press_hpa !== null) {
            lastPressure = item.press_hpa;
            console.log(`Initial previous pressure from Datastore: ${lastPressure} hPa`);
            break;
          }
        }

        // Scan recent records (newest first)
        let foundDrinkOrReminder = false;
        let lastRecordTime = baseTime;
        for (let i = 0; i < items.length; i++) {
          const item = items[i];

          // Determine session start time (going backwards in time)
          // Find if there is a gap > 60 minutes or if the cup was absent (weight <= 15g)
          if (item.timestamp !== undefined) {
            const gap = lastRecordTime - item.timestamp;
            // Only check isCupAbsent if the record is a sensor reading (i.e. weight_g is defined).
            // This prevents marker records (which don't contain weight_g) from being falsely detected as session boundaries.
            const isCupAbsent = item.weight_g !== undefined && item.weight_g <= 15.0;
            if (gap >= REMINDER_THRESHOLD_MS || isCupAbsent) {
              // The session started right after this record (which is the previous item in the descending array).
              // If there is no previous item in items (i.e. i === 0), it means the session started with the current batch.
              sessionStartTime = (i > 0 && items[i - 1]) ? items[i - 1].timestamp : firstRecordTimestamp;
              console.log(`Session start detected (due to gap or absent cup) at timestamp: ${new Date(sessionStartTime).toISOString()}`);
              boundaryFound = true;
              break; // Stop scanning since we reached the session boundary
            }
            lastRecordTime = item.timestamp;
          }

          // Find the most recent drink notification timestamp
          if (item.drink_notification_sent && lastDrinkNotificationTime === null) {
            lastDrinkNotificationTime = item.timestamp;
            console.log(`Last drink notification detected at timestamp: ${new Date(lastDrinkNotificationTime).toISOString()}`);
          }

          // Accumulate consumed volume since the last notification (only if we haven't found the notification marker yet)
          if (lastDrinkNotificationTime === null && item.consumed_ml > 0) {
            consumedSinceLastNotification += item.consumed_ml;
            console.log(`Accumulated past drink since last notification: ${item.consumed_ml} ml. Total now: ${consumedSinceLastNotification} ml`);
          }

          // Scan for last drink time and reminder marker
          if (!foundDrinkOrReminder) {
            if (item.reminder_sent) {
              reminderAlreadySent = true;
              console.log(`Reminder already sent at timestamp: ${item.timestamp}`);
              foundDrinkOrReminder = true;
            }
            if (item.consumed_ml > 0) {
              lastDrinkTime = item.timestamp;
              console.log(`Last drink detected at timestamp: ${lastDrinkTime}`);
              foundDrinkOrReminder = true;
            }
          }
        }

        // If we ran through all items without finding a gap or cup absence,
        // the session started at the oldest record in the list
        if (!boundaryFound && items.length > 0) {
          const oldestItem = items[items.length - 1];
          sessionStartTime = oldestItem.timestamp || firstRecordTimestamp;
          console.log(`Session start defaulted to oldest item timestamp: ${new Date(sessionStartTime).toISOString()}`);
        }
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

  // Check if the cup is present on the coaster (weight > 15g)
  const isCupPresent = latestRecord.weight_g !== undefined && latestRecord.weight_g > 15.0;
  console.log(`Cup presence check: ${isCupPresent} (latest weight: ${latestRecord.weight_g} g)`);

  // Rate-limiting for drink notifications (at most once every 30 minutes)
  let shouldSendDrinkNotification = false;
  if (didDrink) {
    const now = Date.now();
    if (lastDrinkNotificationTime === null || (now - lastDrinkNotificationTime) >= DRINK_NOTIFICATION_THRESHOLD_MS) {
      shouldSendDrinkNotification = true;
      console.log(`Drink notification triggered. Last notification: ${lastDrinkNotificationTime ? new Date(lastDrinkNotificationTime).toISOString() : "never"}`);
    } else {
      console.log(`Drink notification suppressed due to 30-min rate limit. Elapsed: ${Math.round((now - lastDrinkNotificationTime) / 60000)} min`);
    }
  }

  // 7. Check hydration reminder condition
  // If user drank in this batch, reset the reminder state (drink clears the reminder)
  let needsReminder = false;
  if (didDrink) {
    // User just drank — no reminder needed, and any existing reminder marker is implicitly cleared
    // (next time we scan, this drink record will be found before the marker)
    reminderAlreadySent = false;
    console.log("User drank in this batch. Reminder state cleared.");
  } else if (!reminderAlreadySent) {
    // Check if it's been 60+ minutes since last drink (or since session started if they haven't drunk yet)
    const now = Date.now();
    const baselineTime = lastDrinkTime !== null ? lastDrinkTime : sessionStartTime;
    if (now - baselineTime >= REMINDER_THRESHOLD_MS) {
      needsReminder = true;
      console.log(`Hydration reminder triggered. Baseline time: ${new Date(baselineTime).toISOString()}, elapsed: ${Math.round((now - baselineTime) / 60000)} min`);
    } else {
      console.log(`Reminder not needed yet. Baseline time: ${new Date(baselineTime).toISOString()}, elapsed: ${Math.round((now - baselineTime) / 60000)} min`);
    }
  } else {
    console.log("Reminder already sent. Skipping until user drinks.");
  }

  if (isCupPresent && (isHeatRisk || isPressureDrop || shouldSendDrinkNotification || needsReminder)) {
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
- 今回の水分補給検知: ${didDrink ? `あり（合計補給量: ${consumedSinceLastNotification.toFixed(1)} ml）` : "なし（お水は飲んでいません）"}
- 水分補給リマインド: ${needsReminder ? "1時間以上お水を飲んでいません！優しくお水を飲むよう促してください。" : "リマインド不要"}

【命令・ルール】
1. 数値情報をそのまま伝えるのではなく、体感やこまめちゃんの気分・心配事に翻訳して伝えてください。
2. 熱中症リスクや、気圧低下による水分バランスの乱れ（水毒・自律神経の乱れ・脱水による血液の滞り）に合わせたアドバイスをしてください。特に低気圧時は「がぶ飲み」ではなく「ノンカフェインのドリンクをこまめにちびちび飲む」ことが推奨される医学的な理由を、優しくかみ砕いて説明してください。
3. 水, お茶, スポーツドリンク, ジュース, コーヒーなど、あらゆる飲み物に対応した親しみやすい表現にし、白湯に限定しないでください。
4. 今回お水が「なし（飲んでいない）」と判定されている場合は、「お水を飲んで偉い」「ごくごく飲んだね」などの、お水を飲んだことを前提とした表現は絶対に避けてください。代わりに、お水を飲んでいないことを心配して、水分補給を促すメッセージにしてください。
5. 今回お水が「あり（飲んだ）」と判定されている場合は、しっかりとそのこと（合計補給量）を褒めちぎってあげてください。
6. LINE用のチャットメッセージとして150文字以内で作成してください。`;

        const userMessage = "アドバイスを作ってね！";

        let formattedText = null;

        try {
          console.log("Requesting Gemini message generation...");
          // Request Gemini API to generate the custom message (using native fetch)
          const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiApiKey}`;
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

          if (geminiResponse.ok) {
            const geminiData = await geminiResponse.json();
            const textMessage =
              geminiData.candidates &&
              geminiData.candidates[0] &&
              geminiData.candidates[0].content &&
              geminiData.candidates[0].content.parts &&
              geminiData.candidates[0].content.parts[0] &&
              geminiData.candidates[0].content.parts[0].text;

            if (textMessage) {
              formattedText = textMessage.trim();
              console.log("Gemini generated text:", formattedText);
            } else {
              console.warn("Gemini API did not return candidates or text.");
            }
          } else {
            console.warn(`Gemini API returned status ${geminiResponse.status}. Falling back to static message.`);
          }
        } catch (geminiErr) {
          console.error("Failed to generate message via Gemini API, falling back to static message:", geminiErr);
        }

        // Fallback message if Gemini failed or returned empty
        if (!formattedText) {
          console.log("Using fallback static message.");
          let alerts = [];
          if (isHeatRisk) {
            alerts.push(`お部屋が暑くなってるよ（簡易WBGT: ${currentWbgt.toFixed(1)}）。熱中症に気をつけてね！`);
          }
          if (isPressureDrop) {
            alerts.push(`気圧が急に下がったよ（気圧変化: ${currentDP.toFixed(1)} hPa）。頭痛に気をつけて、ノンカフェインのドリンクをこまめにちびちび飲んでね！`);
          }
          if (didDrink) {
            alerts.push(`お水を ${consumedSinceLastNotification.toFixed(0)} ml 飲んだね！偉い偉い！`);
          }
          if (needsReminder) {
            alerts.push(`1時間以上お水飲んでないよ！こまめに水分補給しようね！`);
          }

          if (alerts.length > 0) {
            formattedText = `こまだよ！\n` + alerts.join("\n");
          } else {
            formattedText = `こまだよ！水分補給をこまめにしようね！`;
          }
        }

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

        // 8. Write reminder marker to datastore to prevent repeated reminders
        if (needsReminder && tableId) {
          try {
            await datastore.putItem({
              tableId: tableId,
              item: {
                deviceId: "komame-coaster",
                timestamp: Date.now(),
                reminder_sent: true,
              },
            });
            console.log("Reminder marker saved to Datastore.");
          } catch (markerErr) {
            console.error("Failed to save reminder marker:", markerErr);
          }
        }

        // 9. Write drink notification marker to datastore to prevent repeated notifications within 30 minutes
        if (didDrink && tableId) {
          try {
            await datastore.putItem({
              tableId: tableId,
              item: {
                deviceId: "komame-coaster",
                timestamp: Date.now(),
                drink_notification_sent: true,
              },
            });
            console.log("Drink notification marker saved to Datastore.");
          } catch (markerErr) {
            console.error("Failed to save drink notification marker:", markerErr);
          }
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
      totalConsumed: parseFloat(consumedSinceLastNotification.toFixed(2)),
    }),
  };
};
