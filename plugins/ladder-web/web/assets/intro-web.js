(function(global){
  'use strict';
  var TEXT={
    zh:{client:'客户端：',web:'网页端：',download:'网页版 YGOPro：{link}，无须下载，支持手机。当前可能存在 bug 或功能不完善的问题，正在持续更新。开源地址：{source}。',play:'点开即玩',
      regular:'点击「网页联机」→填写玩家昵称和房间名→点击「连接」。房间名规则与客户端相同；与朋友对战时填写相同房间名。',
      ladder:'点击「一键匹配」进入 TT 队列。可先在官网设置中保存账号密码；未保存时，在网页版填写「昵称$密码」后连接。未注册昵称会自动注册，已注册昵称需填写正确密码。'},
    ja:{client:'クライアント：',web:'Web版：',download:'YGOPro Web版：{link}。ダウンロード不要、スマートフォン対応。バグや未完成の機能がある場合があり、継続して更新しています。ソース：{source}。',play:'今すぐプレイ',
      regular:'「Web対戦」→名前とルーム名を入力→「接続」。ルーム名のルールはクライアント版と同じです。友人と対戦する場合は同じルーム名を入力してください。',
      ladder:'「クイックマッチ」でTTマッチングへ進みます。設定でアカウントを保存するか、Web版で「名前$パスワード」を入力して接続します。未登録名は自動登録され、登録済みの名前には正しいパスワードが必要です。'},
    en:{client:'Client: ',web:'Web: ',download:'YGOPro web client: {link}. No download needed; supports phones. Bugs and incomplete features may remain, and updates are ongoing. Open source: {source}.',play:'Play now',
      regular:'Choose “Play online” → enter your nickname and room name → “Connect”. Room-name rules match the desktop client. Use the same room name to play with friends.',
      ladder:'Choose “Quick match” for the TT queue. Save your account in Settings first, or enter “nickname$password” in the web client and connect. New names are registered automatically; existing names require the correct password.'},
    ko:{client:'클라이언트: ',web:'웹: ',download:'YGOPro 웹 버전: {link}. 다운로드 없이 휴대폰에서도 플레이할 수 있습니다. 버그나 미완성 기능이 있을 수 있으며 계속 업데이트 중입니다. 오픈 소스: {source}.',play:'바로 플레이',
      regular:'「웹 대전」→닉네임과 방 이름 입력→「연결」. 방 이름 규칙은 클라이언트와 같습니다. 친구와 대전하려면 같은 방 이름을 입력하세요.',
      ladder:'「빠른 매칭」으로 TT 대기열에 참가합니다. 설정에서 계정을 저장하거나 웹 클라이언트에서 「닉네임$비밀번호」를 입력한 후 연결하세요. 미등록 닉네임은 자동 등록되며 등록된 닉네임은 올바른 비밀번호가 필요합니다.'}
  };
  function clientEntry(){
    try{return global.SrvproWeb.clientEntry();}catch{return null;}
  }
  function updateLinks(){
    var target=clientEntry();
    document.querySelectorAll('[data-intro-web-play]').forEach(function(link){if(target)link.href=target.href;});
  }
  global.SrvproIntroWeb={apply:function(dictionary){
    var target=clientEntry();
    if(!target)return;
    var node=document.createElement('p');node.dataset.webIntro='';node.dataset.i18n='download_web';
    document.querySelector('[data-i18n="download_desktop"]').after(node);
    Object.keys(TEXT).forEach(function(lang){
      var text=TEXT[lang];
      var link='<a data-intro-web-play href="'+(target?target.href:'')+'" target="_blank" rel="noopener">'+text.play+'</a>';
      dictionary[lang].download_web=text.download.replace('{link}',link).replace('{source}','<a href="https://github.com/301zrg/srvprotiantiweb" target="_blank" rel="noopener">srvprotiantiweb</a>');
      dictionary[lang].content1=text.client+dictionary[lang].content1+'<span class="web-client-instructions">'+text.web+text.regular+'</span>';
      dictionary[lang].content2=text.client+dictionary[lang].content2+'<span class="web-client-instructions">'+text.web+text.ladder+'</span>';
    });
  }};
  document.addEventListener('srvpro-language-change',updateLinks);
})(window);
