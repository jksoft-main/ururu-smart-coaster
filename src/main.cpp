#include <M5Unified.h>
#include <Avatar.h>
#include <WiFi.h>
#include <WebServer.h>
#include <DNSServer.h>
#include <Preferences.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <UNIT_SCALES.h>
#include <M5UnitENV.h>
#include <vector>

// --- 定数定義 ---
#define ENEBULAR_ENDPOINT "https://ev2-prod-node-red-a4d0ce4a-7ff.herokuapp.com/api"
const char* AP_SSID = "Komame-Setup";
const float EMPTY_WEIGHT_THRESHOLD = 15.0f; // コップ有無判定の閾値（g）
const unsigned long WEIGHT_SAMPLE_INTERVAL = 200; // 重量サンプリング間隔 (ms)
const unsigned long ENV_SAMPLE_INTERVAL = 5000;    // 環境データサンプリング間隔 (ms)
const unsigned long HTTP_POST_INTERVAL = 30000;    // HTTPS POST送信周期 (ms)

// --- デバイスステート定義 ---
enum DeviceState {
    STATE_EMPTY,       // コップが置かれていない
    STATE_CUP_PLACED,  // コップが置かれ、重量安定
    STATE_DRINKING     // コップが持ち上げられている
};

DeviceState currentState = STATE_EMPTY;
float stableWeight = 0.0f;
float weightBeforeLift = 0.0f;
float consumedMl = 0.0f;

// 安定判定用バッファ
float lastSamples[5] = {0.0f};
int sampleIndex = 0;
bool bufferFilled = false;

// --- 環境センサー ---
SHT3X sht3x;
QMP6988 qmp;
float currentTemp = 0.0f;
float currentHumi = 0.0f;
float currentPress = 0.0f;
float currentWbgt = 0.0f;

// --- 重量センサー ---
UNIT_SCALES scales;

// --- Wi-Fi & Web設定 ---
WebServer server(80);
DNSServer dnsServer;
Preferences prefs;
String wifiSsid = "";
String wifiPassword = "";
String enebularApiKey = "";
bool isApMode = false;

struct WifiNetwork {
    String ssid;
    int32_t rssi;
    uint8_t encryptionType;
};
std::vector<WifiNetwork> scannedNetworks;

// --- アバター ---
using namespace m5avatar;
Avatar avatar;
unsigned long expressionResetTime = 0;
unsigned long speechResetTime = 0;
Expression defaultExpression = Expression::Neutral;

// --- タイマー ---
unsigned long lastWeightSampleTime = 0;
unsigned long lastEnvSampleTime = 0;
unsigned long lastPostTime = 0;
bool triggerImmediatePost = false;

// --- LED制御 ---
unsigned long ledResetTime = 0;
bool isLedActive = false;

// --- キャプティブポータル用 HTML テンプレート (メモリ節約のため PROGMEM) ---
const char HTTP_HTML_START[] PROGMEM = 
"<!DOCTYPE html>"
"<html lang=\"ja\">"
"<head>"
"<meta charset=\"UTF-8\">"
"<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">"
"<title>こまめちゃん 設定</title>"
"<style>"
"body { font-family: -apple-system, BlinkMacSystemFont, \"Segoe UI\", Roboto, sans-serif; background: linear-gradient(135deg, #e0f2fe 0%, #bae6fd 100%); color: #1e293b; margin: 0; padding: 20px; display: flex; justify-content: center; align-items: center; min-height: 100vh; }"
".card { background: rgba(255, 255, 255, 0.9); backdrop-filter: blur(10px); border-radius: 20px; padding: 30px; box-shadow: 0 10px 25px rgba(0, 0, 0, 0.05); width: 100%; max-width: 400px; border: 1px solid rgba(255, 255, 255, 0.3); box-sizing: border-box; }"
"h1 { font-size: 24px; text-align: center; margin-bottom: 5px; color: #0284c7; font-weight: 700; }"
".subtitle { text-align: center; font-size: 13px; color: #64748b; margin-bottom: 25px; }"
".form-group { margin-bottom: 20px; }"
"label { display: block; font-size: 14px; font-weight: 600; margin-bottom: 8px; color: #475569; }"
"input[type=\"text\"], input[type=\"password\"] { width: 100%; padding: 12px; border-radius: 10px; border: 1px solid #cbd5e1; font-size: 15px; box-sizing: border-box; transition: all 0.3s ease; background-color: #f8fafc; }"
"input[type=\"text\"]:focus, input[type=\"password\"]:focus { outline: none; border-color: #0284c7; background-color: #fff; box-shadow: 0 0 0 3px rgba(2, 132, 199, 0.15); }"
".network-list { max-height: 150px; overflow-y: auto; border: 1px solid #cbd5e1; border-radius: 10px; padding: 5px; background: #f8fafc; margin-bottom: 10px; }"
".network-item { padding: 10px; border-radius: 8px; cursor: pointer; transition: background 0.2s; font-size: 14px; display: flex; justify-content: space-between; align-items: center; }"
".network-item:hover { background: #e2e8f0; }"
".network-item.selected { background: #bae6fd; font-weight: bold; color: #0369a1; }"
".rssi { font-size: 12px; color: #94a3b8; }"
"button { width: 100%; padding: 14px; background: linear-gradient(135deg, #0ea5e9 0%, #0284c7 100%); color: white; border: none; border-radius: 12px; font-size: 16px; font-weight: 600; cursor: pointer; box-shadow: 0 4px 12px rgba(2, 132, 199, 0.2); transition: all 0.3s; margin-top: 10px; }"
"button:hover { transform: translateY(-1px); box-shadow: 0 6px 16px rgba(2, 132, 199, 0.3); }"
"button:active { transform: translateY(1px); }"
".footer { text-align: center; font-size: 11px; color: #94a3b8; margin-top: 25px; }"
"</style>"
"<script>"
"function selectSsid(element, ssid) {"
"  document.getElementById('ssid').value = ssid;"
"  var items = document.querySelectorAll('.network-item');"
"  items.forEach(function(item) { item.classList.remove('selected'); });"
"  element.classList.add('selected');"
"}"
"</script>"
"</head>"
"<body>"
"<div class=\"card\">"
"  <h1>こまめちゃん 設定</h1>"
"  <div class=\"subtitle\">Wi-FiとEnebularの連携設定を行います。</div>"
"  <form action=\"/save\" method=\"POST\">"
"    <div class=\"form-group\">"
"      <label>Wi-Fi ネットワークを選択</label>"
"      <div class=\"network-list\">"
"        <!-- NETWORK_ITEMS_PLACEHOLDER -->"
"      </div>"
"      <input type=\"text\" id=\"ssid\" name=\"ssid\" placeholder=\"または直接SSIDを入力\" required value=\"<!-- SAVED_SSID -->\">"
"    </div>"
"    <div class=\"form-group\">"
"      <label for=\"password\">Wi-Fi パスワード</label>"
"      <input type=\"password\" id=\"password\" name=\"password\" placeholder=\"パスワードを入力\">"
"    </div>"
"    <div class=\"form-group\">"
"      <label for=\"api_key\">Enebular API キー</label>"
"      <input type=\"text\" id=\"api_key\" name=\"api_key\" placeholder=\"APIキーを入力\" value=\"<!-- SAVED_API_KEY -->\">"
"    </div>"
"    <button type=\"submit\">設定を保存して再起動</button>"
"  </form>"
"  <div class=\"footer\">こまめちゃん Smart Coaster v1.0</div>"
"</div>"
"</body>"
"</html>";

// --- 前方宣言 ---
void setupAvatar();
void scanWifi();
String getHtmlPage();
void startApMode();
bool connectWifi();
void handleWeightUpdate();
void handleEnvUpdate();
void sendDataToEnebular();
void setMiniscaleLED(uint32_t color, unsigned long durationMs = 0);
void setAvatarExpression(Expression expr, unsigned long durationMs = 0);
void setAvatarSpeech(const char* text, unsigned long durationMs = 0);

// --- Wi-Fiスキャン処理 ---
void scanWifi() {
    scannedNetworks.clear();
    int n = WiFi.scanNetworks();
    for (int i = 0; i < n; ++i) {
        String ssid = WiFi.SSID(i);
        if (ssid.length() == 0) continue;
        
        bool duplicate = false;
        for (const auto& net : scannedNetworks) {
            if (net.ssid == ssid) {
                duplicate = true;
                break;
            }
        }
        if (!duplicate) {
            scannedNetworks.push_back({ssid, WiFi.RSSI(i), WiFi.encryptionType(i)});
        }
    }
}

// --- 設定Webページ生成 ---
String getHtmlPage() {
    String html = String(FPSTR(HTTP_HTML_START));

    String netItemsHtml = "";
    if (scannedNetworks.empty()) {
        netItemsHtml += "<div class='network-item' style='cursor:default;'>ネットワークが見つかりませんでした</div>";
    } else {
        for (const auto& net : scannedNetworks) {
            String secureIcon = (net.encryptionType != WIFI_AUTH_OPEN) ? " 🔒" : "";
            netItemsHtml += "<div class='network-item";
            if (net.ssid == wifiSsid) {
                netItemsHtml += " selected";
            }
            netItemsHtml += "' onclick=\"selectSsid(this, '" + net.ssid + "')\">";
            netItemsHtml += "<span>" + net.ssid + secureIcon + "</span>";
            netItemsHtml += "<span class='rssi'>" + String(net.rssi) + " dBm</span>";
            netItemsHtml += "</div>";
        }
    }

    html.replace("<!-- NETWORK_ITEMS_PLACEHOLDER -->", netItemsHtml);
    html.replace("<!-- SAVED_SSID -->", wifiSsid);
    html.replace("<!-- SAVED_API_KEY -->", enebularApiKey);

    return html;
}

// --- APモード起動 ---
void startApMode() {
    isApMode = true;
    WiFi.disconnect();
    WiFi.mode(WIFI_AP);
    
    // スキャンしてからAPを開始する
    scanWifi();
    
    WiFi.softAP(AP_SSID);
    delay(100);
    
    dnsServer.start(53, "*", WiFi.softAPIP());
    
    server.on("/", HTTP_GET, []() {
        server.send(200, "text/html", getHtmlPage());
    });

    server.on("/save", HTTP_POST, []() {
        String newSsid = server.arg("ssid");
        String newPassword = server.arg("password");
        String newApiKey = server.arg("api_key");

        prefs.begin("komame", false);
        prefs.putString("ssid", newSsid);
        prefs.putString("password", newPassword);
        prefs.putString("api_key", newApiKey);
        prefs.end();

        String response = "<html><head><meta charset='UTF-8'><meta name='viewport' content='width=device-width, initial-scale=1.0'><title>保存完了</title>";
        response += "<style>body{font-family:sans-serif;background:#e0f2fe;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;color:#1e293b;}";
        response += ".card{background:white;padding:30px;border-radius:20px;box-shadow:0 10px 25px rgba(0,0,0,0.05);text-align:center;max-width:320px;}";
        response += "h1{color:#0284c7;font-size:22px;} p{font-size:14px;color:#64748b;line-height:1.6;}</style></head>";
        response += "<body><div class='card'><h1>設定を保存しました</h1><p>こまめちゃんを再起動します。<br>Wi-Fi: <b>" + newSsid + "</b> に接続します。</p></div>";
        response += "<script>setTimeout(function(){window.location.reload();}, 5000);</script></body></html>";

        server.send(200, "text/html", response);
        delay(2000);
        ESP.restart();
    });

    server.onNotFound([]() {
        server.sendHeader("Location", "http://192.168.4.1/", true);
        server.send(302, "text/plain", "");
    });

    server.begin();
    
    setAvatarExpression(Expression::Doubt);
    setAvatarSpeech("Wi-Fi設定してね");
    Serial.println("AP Mode Started. SSID: " + String(AP_SSID));
    Serial.print("IP address: ");
    Serial.println(WiFi.softAPIP());
}

// --- Wi-Fi接続処理 ---
bool connectWifi() {
    if (wifiSsid.length() == 0) {
        return false;
    }
    
    Serial.print("Connecting to Wi-Fi: ");
    Serial.println(wifiSsid);
    
    setAvatarExpression(Expression::Sleepy);
    setAvatarSpeech("接続中...");
    
    WiFi.mode(WIFI_STA);
    WiFi.begin(wifiSsid.c_str(), wifiPassword.c_str());
    
    unsigned long startAttemptTime = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - startAttemptTime < 15000) {
        M5.update();
        delay(500);
        Serial.print(".");
    }
    Serial.println();
    
    if (WiFi.status() == WL_CONNECTED) {
        Serial.println("Wi-Fi Connected!");
        Serial.print("IP Address: ");
        Serial.println(WiFi.localIP());
        setAvatarExpression(Expression::Happy, 3000);
        setAvatarSpeech("接続完了！", 3000);
        return true;
    } else {
        Serial.println("Wi-Fi Connection Failed.");
        return false;
    }
}

// --- アバター初期化 ---
void setupAvatar() {
    avatar.setScale(0.4f);            // 128x128画面用に縮小
    avatar.setPosition(-56, -96);    // 画面中央に補正
    
    Face* face = avatar.getFace();
    face->setLeftEye(new Eye(12, false));
    face->setRightEye(new Eye(12, true));
    face->setMouth(new Mouth(50, 90, 6, 60));
    
    avatar.setSpeechFont(&fonts::lgfxJapanGothicP_16); // プロポーショナル日本語フォント（16px）を割り当て
    avatar.init(); 
}

// --- 重量センサー更新とステートマシン ---
void handleWeightUpdate() {
    float rawWeight = scales.getWeight();
    if (rawWeight < 0.0f) {
        rawWeight = 0.0f; // 風袋引き後の負値を防止
    }
    Serial.printf("Raw ADC: %.1f, Weight: %.1f g\n", scales.getRawADC(), rawWeight);
    
    // 安定度サンプリング
    lastSamples[sampleIndex] = rawWeight;
    sampleIndex = (sampleIndex + 1) % 5;
    if (sampleIndex == 0) {
        bufferFilled = true;
    }
    
    // バッファが満たされるまではステートマシンをスキップ
    if (!bufferFilled) {
        return;
    }
    
    // 安定度（直近5サンプルの最大・最小差）の算出
    float maxVal = lastSamples[0];
    float minVal = lastSamples[0];
    for (int i = 1; i < 5; ++i) {
        if (lastSamples[i] > maxVal) maxVal = lastSamples[i];
        if (lastSamples[i] < minVal) minVal = lastSamples[i];
    }
    
    bool isStable = (maxVal - minVal) <= 2.5f; // ノイズ許容度を上げるため1.0gから2.5gに緩和
    float currentStableWeight = rawWeight;
    
    bool cupPresent = currentStableWeight > EMPTY_WEIGHT_THRESHOLD;
    
    switch (currentState) {
        case STATE_EMPTY:
            if (cupPresent && isStable) {
                currentState = STATE_CUP_PLACED;
                stableWeight = currentStableWeight;
                Serial.printf("[State] Cup Placed. Weight: %.1f g\n", stableWeight);
                
                // コップが戻ってきたとき（DRINKINGからの遷移）の水分摂取検知
                if (weightBeforeLift > EMPTY_WEIGHT_THRESHOLD) {
                    if (stableWeight < weightBeforeLift - 5.0f) {
                        // 水分補給が行われた
                        float consumed = weightBeforeLift - stableWeight;
                        consumedMl += consumed;
                        Serial.printf("補給検知(持ち上げ): %.1f ml (累計: %.1f ml)\n", consumed, consumedMl);
                        
                        setAvatarExpression(Expression::Happy, 5000);
                        setAvatarSpeech("ごくごく！", 5000);
                        setMiniscaleLED(0x00FF00, 5000); // LED 緑色
                        triggerImmediatePost = true;
                    } else if (stableWeight > weightBeforeLift + 5.0f) {
                        // コップに飲料が注ぎ足された（おかわり）
                        Serial.printf("注ぎ足し検知: %.1f g\n", stableWeight);
                        setAvatarExpression(Expression::Happy, 5000);
                        setAvatarSpeech("ありがとう！", 5000);
                        setMiniscaleLED(0x0000FF, 5000); // LED 青色
                    } else {
                        // 変化なし（ただ戻された）
                        Serial.println("変化なし（ただ戻された）");
                        setAvatarExpression(Expression::Neutral, 2000);
                        setAvatarSpeech("おかえり！", 2000);
                    }
                    weightBeforeLift = 0.0f; // バッファクリア
                }
            }
            break;
            
        case STATE_CUP_PLACED:
            if (!cupPresent) {
                // コップが持ち上げられた
                currentState = STATE_DRINKING;
                weightBeforeLift = stableWeight;
                Serial.printf("[State] Cup Lifted. Pre-lift weight: %.1f g\n", weightBeforeLift);
                
                // 持ち上げ時のフィードバックを追加（反応をわかりやすくするため）
                setAvatarExpression(Expression::Doubt, 4000);
                setAvatarSpeech("のむのかな？", 4000);
                setMiniscaleLED(0xFFFF00, 4000); // 黄色LED点灯
            } else if (isStable) {
                // コップを置いたまま、ストロー等で飲まれた場合（重量減少）
                if (currentStableWeight < stableWeight - 5.0f) {
                    float consumed = stableWeight - currentStableWeight;
                    consumedMl += consumed;
                    Serial.printf("補給検知(ストロー): %.1f ml (累計: %.1f ml)\n", consumed, consumedMl);
                    
                    stableWeight = currentStableWeight;
                    setAvatarExpression(Expression::Happy, 5000);
                    setAvatarSpeech("ごくごく！", 5000);
                    setMiniscaleLED(0x00FF00, 5000); // LED 緑色
                    triggerImmediatePost = true;
                } 
                // 置いたまま注ぎ足された場合
                else if (currentStableWeight > stableWeight + 5.0f) {
                    Serial.printf("注ぎ足し検知(静置): %.1f g\n", currentStableWeight);
                    stableWeight = currentStableWeight;
                    setAvatarExpression(Expression::Happy, 5000);
                    setAvatarSpeech("ありがとう！", 5000);
                    setMiniscaleLED(0x0000FF, 5000); // LED 青色
                }
            }
            break;
            
        case STATE_DRINKING:
            if (cupPresent && isStable) {
                // コップが再び置かれた
                currentState = STATE_CUP_PLACED;
                stableWeight = currentStableWeight;
                Serial.printf("[State] Cup Returned. Weight: %.1f g\n", stableWeight);
                
                if (weightBeforeLift > EMPTY_WEIGHT_THRESHOLD) {
                    if (stableWeight < weightBeforeLift - 5.0f) {
                        float consumed = weightBeforeLift - stableWeight;
                        consumedMl += consumed;
                        Serial.printf("補給検知(持ち上げ帰還): %.1f ml (累計: %.1f ml)\n", consumed, consumedMl);
                        
                        setAvatarExpression(Expression::Happy, 5000);
                        setAvatarSpeech("ごくごく！", 5000);
                        setMiniscaleLED(0x00FF00, 5000);
                        triggerImmediatePost = true;
                    } else if (stableWeight > weightBeforeLift + 5.0f) {
                        Serial.printf("注ぎ足し検知(帰還): %.1f g\n", stableWeight);
                        setAvatarExpression(Expression::Happy, 5000);
                        setAvatarSpeech("おかわりだ！", 5000);
                        setMiniscaleLED(0x0000FF, 5000);
                    } else {
                        // 変化なし（ただ戻された）
                        Serial.println("変化なし（ただ戻された）");
                        setAvatarExpression(Expression::Neutral, 2000);
                        setAvatarSpeech("おかえり！", 2000);
                    }
                    weightBeforeLift = 0.0f;
                }
            } else if (!cupPresent && isStable) {
                // コップがない状態が継続しているため EMPTY に移行
                currentState = STATE_EMPTY;
                stableWeight = 0.0f; // 安定重量をリセット
                Serial.println("[State] Scale is Empty.");
            }
            break;
    }
}

// --- 環境センサー更新 ---
void handleEnvUpdate() {
    if (sht3x.update()) {
        currentTemp = sht3x.cTemp;
        currentHumi = sht3x.humidity;
    }
    
    if (qmp.update()) {
        currentPress = qmp.pressure / 100.0f; // Pa -> hPa
    }
    
    // 簡易暑さ指数（WBGT）の算出式
    // WBGT_simple = 0.725 * T + 0.0368 * H + 0.00364 * (T * H) - 3.246
    currentWbgt = 0.725f * currentTemp + 0.0368f * currentHumi + 0.00364f * (currentTemp * currentHumi) - 3.246f;
    
    Serial.printf("Temp: %.1f C, Humi: %.1f %%, Press: %.1f hPa, WBGT: %.1f\n", 
                  currentTemp, currentHumi, currentPress, currentWbgt);
                  
    // 熱中症危険環境時のアバター警告表示
    if (currentWbgt >= 28.0f) {
        defaultExpression = Expression::Sad;
        setAvatarExpression(Expression::Sad);
        setAvatarSpeech("お水飲もう！");
    } else {
        defaultExpression = Expression::Neutral;
        // 表情タイマーが作動していなければ通常顔に戻す
        if (millis() > expressionResetTime) {
            setAvatarExpression(Expression::Neutral);
        }
        if (millis() > speechResetTime) {
            avatar.setSpeechText("");
        }
    }
}

// --- enebular へのデータ送信 ---
void sendDataToEnebular() {
    if (WiFi.status() != WL_CONNECTED) {
        Serial.println("Skipping HTTPS POST: Wi-Fi disconnected.");
        return;
    }
    
    WiFiClientSecure client;
    client.setInsecure(); // 証明書検証をスキップして期限切れを防ぐ
    
    HTTPClient http;
    http.begin(client, ENEBULAR_ENDPOINT);
    http.addHeader("Content-Type", "application/json");
    
    if (enebularApiKey.length() > 0) {
        http.addHeader("x-api-key", enebularApiKey);
    }
    
    float currentWeight = scales.getWeight();
    if (currentWeight < 0.0f) {
        currentWeight = 0.0f;
    }
    
    // JSON ペイロード構築
    char jsonPayload[256];
    snprintf(jsonPayload, sizeof(jsonPayload),
             "{\"weight_g\":%.1f,\"consumed_ml\":%.1f,\"temp_c\":%.1f,\"humi_pct\":%.1f,\"press_hpa\":%.1f}",
             currentWeight, consumedMl, currentTemp, currentHumi, currentPress);
             
    Serial.print("Sending Payload: ");
    Serial.println(jsonPayload);
    
    int httpResponseCode = http.POST(jsonPayload);
    if (httpResponseCode > 0) {
        Serial.printf("HTTPS POST Success, Response Code: %d\n", httpResponseCode);
    } else {
        Serial.printf("HTTPS POST Failed, Error: %s\n", http.errorToString(httpResponseCode).c_str());
    }
    
    http.end();
}

// --- 計量ユニット LED 制御ユーティリティ ---
void setMiniscaleLED(uint32_t color, unsigned long durationMs) {
    scales.setLEDColor(color);
    if (durationMs > 0) {
        ledResetTime = millis() + durationMs;
        isLedActive = true;
    } else {
        isLedActive = false;
    }
}

// --- アバター表情制御ユーティリティ ---
void setAvatarExpression(Expression expr, unsigned long durationMs) {
    avatar.setExpression(expr);
    if (durationMs > 0) {
        expressionResetTime = millis() + durationMs;
    } else {
        expressionResetTime = 0;
    }
}

// --- アバターセリフ制御ユーティリティ ---
void setAvatarSpeech(const char* text, unsigned long durationMs) {
    avatar.setSpeechText(text);
    if (durationMs > 0) {
        speechResetTime = millis() + durationMs;
    } else {
        speechResetTime = 0;
    }
}

// --- Setup ---
void setup() {
    auto cfg = M5.config();
    M5.begin(cfg);
    
    Serial.begin(115200);
    delay(1000);
    Serial.println("こまめちゃん Smart Coaster Starting...");
    
    // アバター画面の初期化
    setupAvatar();
    
    // 2系統の I2C バス初期化
    // 系統1: 標準 Grove ポート用（計量ユニット）
    scales.begin(&Wire, G2, G1, 0x26);
    delay(100);
    scales.setOffset(); // 起動時に自動風袋引き（ゼロ点合わせ）を行う
    
    // 系統2: ATOMIC ToUnit Base 経由の ENV Ⅲ 用 (SDA=GPIO 5, SCL=GPIO 6)
    Wire1.begin(G5, G6, 400000U);
    sht3x.begin(&Wire1, 0x44, 5, 6, 400000U);
    qmp.begin(&Wire1, 0x70, 5, 6, 400000U);
    
    // Preferences から Wi-Fi 設定および API設定を読み込む
    prefs.begin("komame", true);
    wifiSsid = prefs.getString("ssid", "");
    wifiPassword = prefs.getString("password", "");
    enebularApiKey = prefs.getString("api_key", "");
    prefs.end();
    
    // Wi-Fi 接続試行
    bool wifiConnected = false;
    if (wifiSsid.length() > 0) {
        wifiConnected = connectWifi();
    }
    
    // 接続失敗時、または未設定時はAPモードでキャプティブポータルを起動
    if (!wifiConnected) {
        startApMode();
    } else {
        // 通常起動時：最初の環境測定を実行
        handleEnvUpdate();
        lastEnvSampleTime = millis();
        lastPostTime = millis();
        
        // 動作開始の通知
        setAvatarSpeech("準備できたよ！", 3000);
    }
    
    lastWeightSampleTime = millis();
}

// --- Loop ---
void loop() {
    M5.update();
    
    // --- APモード中のクライアント・DNS処理 ---
    if (isApMode) {
        dnsServer.processNextRequest();
        server.handleClient();
        delay(10);
        return; 
    }
    
    // --- 通常動作モードの処理 ---
    
    unsigned long currentMillis = millis();
    
    // 1. オート風袋引き（M5Atom S3の画面押し込み）
    if (M5.BtnA.wasPressed()) {
        Serial.println("Tare (zero calibration) requested via Button.");
        scales.setOffset();
        consumedMl = 0.0f; // 水分補給量リセット
        currentState = STATE_EMPTY;
        
        // バッファリセット
        sampleIndex = 0;
        bufferFilled = false;
        
        setAvatarExpression(Expression::Happy, 3000);
        setAvatarSpeech("リセットしたよ！", 3000);
        setMiniscaleLED(0x00FF00, 2000); // LED 緑色
    }
    
    // 2. 重量データ更新サンプリング (200ms周期)
    if (currentMillis - lastWeightSampleTime >= WEIGHT_SAMPLE_INTERVAL) {
        lastWeightSampleTime = currentMillis;
        handleWeightUpdate();
    }
    
    // 3. 環境データ更新サンプリング (5000ms周期)
    if (currentMillis - lastEnvSampleTime >= ENV_SAMPLE_INTERVAL) {
        lastEnvSampleTime = currentMillis;
        handleEnvUpdate();
    }
    
    // 4. 定期またはイベント検知時の enebular 送信
    if (triggerImmediatePost || (currentMillis - lastPostTime >= HTTP_POST_INTERVAL)) {
        triggerImmediatePost = false;
        lastPostTime = currentMillis;
        sendDataToEnebular();
    }
    
    // 5. アバター表情リセット処理
    if (expressionResetTime > 0 && currentMillis > expressionResetTime) {
        setAvatarExpression(defaultExpression);
    }
    
    // 6. アバター吹き出しリセット処理
    if (speechResetTime > 0 && currentMillis > speechResetTime) {
        avatar.setSpeechText("");
        speechResetTime = 0;
    }
    
    // 7. 計量ユニット LED 自動消灯処理
    if (isLedActive && currentMillis > ledResetTime) {
        scales.setLEDColor(0x000000); // 消灯
        isLedActive = false;
    }
    
    delay(10);
}
