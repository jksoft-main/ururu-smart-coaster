# 水分補給見守りコースター「こまめちゃん」総合実装仕様書

## 1. システム全体概要

本システムは、M5AtomS3、ATOMIC ToUnit Base、M5Stack用温湿度気圧センサユニット Ver.3（ENV Ⅲ）、およびM5Stack用計量ユニット 5kgレンジ（HX711）を組み合わせ、クラウド上のenebular , Google Gemini API , LINE Messaging API  と連携させた自律型「水分補給見守りコースター」である。

机の上でコップを置くだけで機能するスマートコースターを物理的な起点とし、精密な重量測定（g/ml単位）と、周囲の温湿度・気圧監視を並行して行う。お部屋の温度・湿度や気圧の変化を常にスキャンし、熱中症リスクや気圧低下による不調（気象病）を未然に防ぐために、AI（Gemini）とLINEを通じて「こまめな水分補給」を優しく促す、日常生活に調和したスマートデバイスである。

## 2. ハードウェア物理構成とピンアサイン仕様
ケーブル配線を極限まで省き、スマート型コースターの美観を維持するため、I2Cハブを介さずに「ATOMIC ToUnit Base」（A161）のDIPスイッチ変換機能を活用し、M5Atom S3で完全独立した2系統のI2Cバスを確立する。

### 2.1. 主要パーツ

| 製品名 | 個数 | 説明 | URL | 備考 |
| --- | --- | --- | --- | --- |
| M5 ATOM-S3 | 1 | 計測した値をクラウドにアップロードする本システムのメインマイコン | https://www.switch-science.com/products/8670 | - |
| ATOMIC ToUnit Base | 1 | M5 ATOM-S3に温湿度気圧センサを接続するためのもの。 | https://www.switch-science.com/products/10870 | - |
| M5Stack用温湿度気圧センサユニット Ver.3（ENV Ⅲ） | 1 | 温湿度気圧の測定用 | https://www.switch-science.com/products/7254 | - |
| M5Stack用計量ユニット 5kgレンジ（HX711） | 1 | 水分の重さの計測用 | https://www.switch-science.com/products/9509 | - |

### 2.2 物理接続およびI2Cアドレス構成

| 製品名 | 主要素子 / 動作仕様 | 物理接続方式 | I2Cアドレス |
| ---- | :---- | :---- | :---- |
| M5 ATOM-S3 | ESP32-S3, 0.85" LCD | ホスト | I2Cホスト 2ch |
| ATOMIC ToUnit Base | 底面拡張I/O-Grove変換 | Atom底面にネジ止め | - |
| M5Stack用温湿度気圧センサユニット Ver.3（ENV Ⅲ） | SHT30, QMP6988 | ATOMIC ToUnit BaseのGroveコネクタ | SHT30: 0x44 / QMP6988: 0x70 |
| M5Stack用計量ユニット 5kgレンジ（HX711） | HX711, 24bit ADC | M5 ATOM-S3のGroveコネクタ | 0x26 |

### 2.3 DIPスイッチ設定規則

同一ピンの重複有効化による衝突を避けるため、ATOMIC ToUnit BaseのDIPスライドスイッチを設定する。

* IO1（SDA側）：GPIO 5 のみ「有効（上側）」、その他は「無効（下側）」  
* IO2（SCL側）：GPIO 6 のみ「有効（上側）」、その他は「無効（下側）」  
* M5 ATOM-S3ファームウェア定義：
  - 標準I2Cバス計量ユニット用：`Wire.begin(2, 1)`
  - 拡張I2Cバス温湿度気圧センサユニット用：`Wire1.begin(5, 6)`

## 3. M5 ATOM-S3 ファームウェア実装仕様

開発環境はPlatformIOを使用する。
使用する依存ライブラリは以下のものになります。
- M5Unified
- M5GFX
- M5Stack-Avatar
- M5UnitENV
- M5Unit-Miniscale

### 3.1 アバター画面描画（「こまめちゃん」128×128ピクセル最適化仕様）

M5Stack-AvatarをATOMS3の0.85インチ液晶に適合させるため、以下のスケーリングおよび座標オフセットを初期化時に設定する。

```cpp
#include <M5Unified.h>
#include <Avatar.h>

using namespace m5avatar;
Avatar avatar;

void setupAvatar() {
    avatar.setScale(0.4);            // 320x240を128x128画面用に縮小 [span_11](start_span)[span_11](end_span)[span_14](start_span)[span_14](end_span)
    avatar.setPosition(-56, -96);    // 中央配置座標補正 [span_16](start_span)[span_16](end_span)
    
    // こまめちゃんの可愛らしさを際立たせるパーツ調整 [span_17](start_span)[span_17](end_span)
    Face* face = avatar.getFace();
    face->setLeftEye(new Eye(12, false));
    face->setRightEye(new Eye(12, true));
    face->setMouth(new Mouth(50, 90, 6, 60));
    
    avatar.init(); // お顔の描画と瞬き等の自律アニメーションを開始 
}
```

### 3.2 センサデータ取得とTare（風袋引き）アルゴリズム

計量ユニットとの通信および制御は、公式ライブラリ `M5Unit-Miniscale`（または `UNIT_MINISCALE`）の `UNIT_SCALES` クラスを使用する 。

* 計量（重量）測定：`scales.getWeight()` メソッドを呼び出し、ロードセルから変換された現在の重量を直接float型（g単位）で取得する 。内部の平均化・平滑化処理（デフォルト値10）を適用することでノイズを除去する。
* オート風袋引き（ゼロ点補正）：空のコップをコースターに載せた状態で、M5Atom S3の液晶画面（一体型物理タクトスイッチ）を押し込むと、`scales.setOffset()` が実行され、現在の値を基準のゼロ点（風袋引き）としてセットする。以降は注がれた飲料の増減のみを検出する。
* LED表示：目標達成度や状態に応じて、計量ユニット内蔵のRGB LEDを `scales.setLEDColor(0x00FF00)` などで色制御する。
* 環境データ：`Wire1`（GPIO 5, GPIO 6）を介して `SHT30` および `QMP6988` から温度、湿度、気圧を取得する。

### **3.4 HTTPS POSTデータペイロード（JSON）**

Wi-Fi接続確立後、以下のJSONオブジェクトを構築し、enebular上のHTTPトリガーエンドポイントに向けて30秒周期（または重量変化イベント検知時）でHTTPS POSTを送信する

```json
{
  "weight_g": 180.0,
  "consumed_ml": 20.0,
  "temp_c": 28.5,
  "humi_pct": 60.5,
  "press_hpa": 1009.2
}
```

## 4. enebular（Node-RED）クラウドフロー設計仕様

enebular上のNode-REDは、「HTTP In」ノードまたは「LCDPin」ノードを玄関口としてデータを受信し、データストアに保存しつつ、高度な生活支援・健康維持の自動判定を行うオーケストレーターとして機能する。

### 4.1 熱中症暑さ指数（簡易WBGT）の自律算出
湿度気圧センサユニットから受信した温度 T （℃）および湿度 H （%）に基づき、functionノード内で簡易暑さ指数を自律計算する

$$\text{WBGT}_{\text{simple}} = 0.725T + 0.0368H + 0.00364(T \times H) - 3.246$$

### 4.2 気圧低下（気象病トリガー）の監視
1回前の受信データ（またはデータストアに格納された直近3時間の気圧データ平均値）$P_{\text{past}}$ と、現在の気圧 $P_{\text{now}}$ を比較し、変化量 $\Delta P = P_{\text{now}} - P_{\text{past}}$ を算出する。
- $\Delta P \le -1.5\text{hPa}$ の場合、「気象病警戒フラグ」を true にセットし、AIへのプロンプトに「気圧低下時のこまめな水分補給の医学的根拠（水毒や自律神経、血液の流れの維持）」をコンテキストとして動的に挿入する。


## 5. Google Gemini API 連携プロンプト仕様

Node-RED内の factory-agent-gemini（または node-red-contrib-gemini）ノードを使用し、応答性に優れ、コストパフォーマンスが最高の gemini-2.0-flash-lite モデルを配備する。

### 5.1 動的システムプロンプト（sysPrompt）アサイン規則

用システムプロンプトを組み立ててGemini APIに渡す。

```javascript
// enebular内のプロンプト組み立てFunctionノードのJavaScript例
let wbgt = msg.wbgt;
let dP = msg.dP; // 気圧変化量（マイナス値）
let consumed = msg.payload.consumed_ml;

msg.sysPrompt = `
あなたはM5Atom S3のスマートコースターに宿っている、お水飲み見守りキャラクターの「こまめちゃん」です。
ユーザーを大切に想う、少しお節介で人懐っこい口調（語尾に「〜だよ」「〜ね！」を使用）で語りかけてください。

現在のお部屋のコンテキストを分析してください：
- 簡易暑さ指数(WBGT): ${wbgt} (28以上は熱中症危険)
- 直近の気圧変化: ${dP} hPa (マイナス1.5hPa以下の低下は気象病・低気圧頭痛に警戒)
- 今回のユーザーの水分補給量: ${consumed} ml

【命令・ルール】
1. 数値情報をそのまま伝えるのではなく、体感やこまめちゃんの気分・心配事に翻訳して伝えてください。
2. 熱中症リスクや、気圧低下による水分バランスの乱れ（水毒・自律神経の乱れ・脱水による血液の滞り）に合わせたアドバイスをしてください。特に低気圧時は「がぶ飲み」ではなく「ノンカフェインのドリンクをこまめにちびちび飲む」ことが推奨される医学的な理由を、優しくかみ砕いて説明してください。
3. 水, お茶, スポーツドリンク, ジュース, コーヒーなど、あらゆる飲み物に対応した親しみやすい表現にし、白湯に限定しないでください。
4. LINE用のチャットメッセージとして150文字以内で作成してください。
`;
return msg;
```

## 6. LINE Messaging API 連携仕様

node-red-contrib-line-messaging-api ノード群を使用してLINE BOTと接続する。
1. セキュリティ・API管理：enebularの「LINE Bot Config」に、LINE Developersから取得した「Channel Secret」および「Channel Access Token」を格納する。暗号化された安全なクラウド環境内で処理するため、M5Atom S3やフロントエンド側にトークンが漏洩する危険性をゼロにする。
2. 送信処理：「熱中症リスク/気圧低下時の水分不足」を検知した際に、Geminiから抽出した msg.result を Push Message ノードによってユーザーの userId へ自律的にプッシュ配信する。
