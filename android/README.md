# 简账 Android 包装工程

这是由 Bubblewrap 生成的 Trusted Web Activity 工程，包名为
`com.jianzhang.ledger`，目标 SDK 为 36，最低支持 Android 5（API 21）。

工程只保存可公开的源码和图标，不包含签名密钥、密钥密码、APK、AAB、
Gradle 缓存或用户账单数据。首次构建前需在本机准备自己的
`android.keystore`；测试包和正式上架包应使用不同的签名管理流程。

网站必须公开提供 `/.well-known/assetlinks.json`，且其中的证书指纹必须与
当前安装包的签名一致，才能以无浏览器地址栏的完整应用模式运行。
