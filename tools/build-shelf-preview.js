/**
 * 生成书架预览页：把 www/js/shelf.js 原样内联进来 + 假书数据，
 * 这样在浏览器里能直接看到效果，不用先导入真书。
 * 用法：node tools/build-shelf-preview.js
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const shelfCode = fs.readFileSync(path.join(root, 'www', 'js', 'shelf.js'), 'utf8');

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>砚读 · 多宝格书架（正式代码预览）</title>
<style>
:root{ --page:#EDEDEA; --card:#fff; --ink:#1E3D2C; --accent:#2E6B4A; --muted:#9A9A95;
  --serif:"Songti SC","Noto Serif CJK SC","SimSun",serif;
  --sans:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif; }
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:var(--sans);background:#DEDEDB;min-height:100vh;display:flex;flex-direction:column;
  align-items:center;gap:16px;padding:22px 16px 50px}
.hint{font-size:12.5px;color:#5F6663;text-align:center;max-width:660px;line-height:1.8}
.hint b{color:var(--ink)}
.phone{width:375px;height:812px;background:var(--page);border-radius:42px;overflow:hidden;
  box-shadow:0 0 0 10px #1A1E1C,0 0 0 12px #333A36,0 26px 56px rgba(0,0,0,.3);
  display:flex;flex-direction:column;flex:none}
.shelf-head{display:flex;align-items:center;justify-content:space-between;padding:18px 20px 10px}
.shelf-head h1{font-family:var(--serif);font-size:21px;font-weight:600;letter-spacing:2px;color:var(--ink);line-height:1.2}
.shelf-sub{font-size:12px;color:var(--muted);margin-top:3px}
.btn-primary{background:var(--accent);color:#fff;padding:9px 18px;border-radius:20px;font-size:14px;border:none}
.shelf-stage{flex:1;min-height:0;display:grid;place-items:center;padding:4px 0 6px}
.shelf-stage svg.bogu{width:min(84vw,330px);height:auto;display:block;overflow:visible}
.shelf-stage .bk{cursor:pointer}
.shelf-tip{text-align:center;font-size:11.5px;color:var(--muted);padding:0 20px 10px;min-height:14px}
.ctrl{display:flex;gap:8px;flex-wrap:wrap;justify-content:center;max-width:660px}
.ctrl button{border:1px solid #E0E2DE;background:#fff;border-radius:9px;padding:7px 12px;font-size:12px;
  cursor:pointer;color:#3A403C;font-family:inherit}
.ctrl button.on{background:var(--accent);border-color:var(--accent);color:#fff}
</style>
</head>
<body>

<p class="hint">
  这一页跑的就是 <b>www/js/shelf.js</b> 的正式代码（原样内联），只是喂了假书数据。<br>
  点下面的数字切换书的数量，看架子挤起来是什么样。点书脊会弹出书名。
</p>

<div class="phone">
  <div class="shelf-head">
    <div><h1>砚读</h1><div class="shelf-sub" id="sub">12 本在架</div></div>
    <button class="btn-primary">+ 导入</button>
  </div>
  <div class="shelf-stage" id="stage"></div>
  <div class="shelf-tip" id="tip"></div>
</div>

<div class="ctrl" id="ctrl"></div>

<script>
${shelfCode}
</script>
<script>
var NAMES = ['三体·黑暗森林','雪中悍刀行','明朝那些事儿','乡土中国','百年孤独','围城',
  '三国演义','水浒传','史记','诗经','人间词话','万历十五年','活着','许三观卖血记',
  '平凡的世界','骆驼祥子','边城','呐喊','朝花夕拾','茶馆','雷雨','家','春','秋',
  '静静的顿河','战争与和平','罪与罚','卡拉马佐夫兄弟','追忆似水年华','尤利西斯',
  '道德经','庄子','论语','孟子','孙子兵法','三十六计','资治通鉴','汉书','后汉书','三国志',
  '楚辞','乐府诗集','文心雕龙','搜神记','世说新语','颜氏家训','菜根谭','小窗幽记',
  '浮生六记','影梅庵忆语','陶庵梦忆','西湖梦寻','徐霞客游记','阅微草堂笔记','聊斋志异'];

function mk(n){
  var a=[];
  for(var i=0;i<n;i++){
    a.push({ id:'b'+i, title:NAMES[i%NAMES.length], totalChars:200000+((i*137)%900000), pct:(i*17)%100 });
  }
  return a;
}
var cur=12;
function draw(n){
  cur=n;
  var items=mk(n);
  var res=Shelf.render(document.getElementById('stage'),{
    items:items,
    onItem:function(it){ alert('打开《'+it.title+'》'); }
  });
  document.getElementById('sub').textContent=n+' 本在架';
  document.getElementById('tip').textContent=res.overflow?('架上放不下了，还有 '+res.overflow+' 本没摆出来'):'';
  Array.prototype.forEach.call(document.querySelectorAll('#ctrl button'),function(b){
    b.classList.toggle('on', +b.getAttribute('data-n')===n);
  });
}
[0,3,8,12,25,40,60,90].forEach(function(n){
  var b=document.createElement('button');
  b.textContent=n+' 本'; b.setAttribute('data-n',n);
  b.onclick=function(){ draw(n); };
  document.getElementById('ctrl').appendChild(b);
});
draw(12);
</script>
</body>
</html>
`;

const out = path.join(root, 'design', 'shelf-final.html');
fs.writeFileSync(out, html, 'utf8');
console.log('已生成: ' + out);
console.log('大小: ' + (html.length / 1024).toFixed(1) + ' KB（含内联的 shelf.js ' + (shelfCode.length / 1024).toFixed(1) + ' KB）');
