# 传感器看板 · GitHub Pages 发布文件

本目录可作为独立公开仓库的根目录。只含静态网页、编号映射和发布说明，不含网关固件、设备密钥、AK/SK、原始测量文件或原 Sites 身份。

## 首次发布

1. 在自己的 GitHub 账号创建一个公开仓库，例如 iotda-sensor-dashboard。不上传整个传感器工程。
2. 将本目录全部文件上传到仓库根目录，确保 index.html 直接位于根目录，不是把整个文件夹或 ZIP 作为一个文件上传。
3. 在 Settings → Pages 选择 Deploy from a branch，分支选 main，目录选 /(root)，保存。
4. 等待 GitHub 的部署完成，从 Pages 页面复制真实发布地址。还没有完成以上步骤前，本目录不代表网站已经上线。

平台操作依据：https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site

## 使用与更新

- 水分/蒸腾入口：index.html；ER81C 入口：resistance.html?model=ER81C；ER21T 入口：resistance.html?model=ER21T。两个型号独立筛选、导出和本机删除，默认 ER81C。
- 旧浏览器归档保留，按实际设备身份重新分类；身份不明或冲突记录放入“身份待核对”，不靠通道数量猜测型号。
- 云端兼容旧平铺目录和型号子目录，读取全部分页历史，不设最新 N 条上限。表格每页 100 条，导出和“删除当前筛选”涵盖全部筛选结果，不限于当前表格页。
- 云数据继续从现有华为云 OBS 读取，不改网关、设备身份、云规则或桶数据。
- 本机导入、筛选和删除仍按浏览器分别保存，不是多用户共享删除。换网址不会自动搬迁旧网址的本地缓存。
- 保留手动刷新和历史分页读取，没有恢复实时曲线或增加自动监测。
- 后续更新同一仓库的网页文件，继续使用同一个 Pages 网址；不要上传固件或凭据。
- GitHub Pages 免费托管的适用条件和额度以官方为准；原华为云费用另计。必须用实际使用网络测试，不能保证所有网络均可访问。

## MQTT 成功但没有数据

串口 MQTT 确认仅证明 IoTDA 接收。电阻网关使用 `$oc/devices/{device_id}/sys/messages/up`，须启用对应独立设备的“设备消息 / 设备消息上报”规则，再转发至 OBS。水分/蒸腾的“设备属性上报”规则不能代替它。

ER81C-01 完整包附带的规则导入后默认不启动，需要在控制台检查目标 sensor-1 / sensor_data/resistance/ER81C-01 并启动。不要重复建立已存在的同名规则；先检查现有规则。启用后等待真实上传，再刷新对应型号。网页不会把未归档的 MQTT 消息补造为历史数据。

本次仅更新公开看板；没有更改固件、设备密钥、云规则或桶权限。
