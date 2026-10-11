// 官网所有网页版 YGOPRO 入口共用此配置；改为 false 可关闭全部入口。
// 修改后上传此文件并刷新页面，不影响卡组／录像下载或房间号复制。
if (typeof window.SRVPRO_WEB_CLIENT_ENABLED === 'undefined') {
  window.SRVPRO_WEB_CLIENT_ENABLED = true;
}
// 更换域名时只修改下面的地址。
// 填写完整 HTTPS 网页地址，可包含部署子路径；这里不是 WSS 隧道地址。
// 保留在本脚本之前注入的固定配置，兼容已有部署和本地联调。
if (typeof window.SRVPRO_WEB_CLIENT_URL === 'undefined') {
  window.SRVPRO_WEB_CLIENT_URL = 'https://ocg1103nexus.com/';
}
