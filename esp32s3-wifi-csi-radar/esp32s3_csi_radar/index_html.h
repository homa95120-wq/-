#pragma once
#include <pgmspace.h>

const char INDEX_HTML[] PROGMEM = R"HTML(<!DOCTYPE html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ESP32-S3 CSI Radar</title>
<style>
 body{margin:0;background:#050b05;color:#5f5;font-family:monospace;display:flex;flex-direction:column;align-items:center}
 h1{font-size:16px;margin:10px 0 2px;letter-spacing:2px}
 #st{font-size:12px;color:#9c9;margin-bottom:6px;text-align:center}
 canvas{background:#071007;border:1px solid #163;border-radius:6px;margin:4px}
 #radar{width:min(92vw,420px);height:min(92vw,420px)}
 #hist,#spec{width:min(92vw,420px);height:110px}
 button{background:#0a2;color:#000;border:0;padding:8px 14px;font-family:monospace;font-weight:bold;border-radius:4px;margin:6px}
 .lbl{font-size:11px;color:#6a6;align-self:flex-start;margin-left:max(4vw,calc(50% - 210px))}
 #alarm{font-size:22px;font-weight:bold;height:28px}
</style></head><body>
<h1>Wi-Fi CSI РАДАР</h1>
<div id="st">подключение…</div>
<div id="alarm"></div>
<canvas id="radar" width="420" height="420"></canvas>
<div class="lbl">движение (30 сек)</div>
<canvas id="hist" width="420" height="110"></canvas>
<div class="lbl">амплитуда поднесущих CSI</div>
<canvas id="spec" width="420" height="110"></canvas>
<button onclick="fetch('/calib')">ПЕРЕКАЛИБРОВАТЬ (не двигайся 5 сек)</button>
<script>
const R=document.getElementById('radar').getContext('2d');
const H=document.getElementById('hist').getContext('2d');
const S=document.getElementById('spec').getContext('2d');
let d=null,ang=0,blips=[];

function drawRadar(){
  const W=420,c=W/2,r=c-10;
  R.fillStyle='rgba(7,16,7,0.25)';R.fillRect(0,0,W,W);
  R.strokeStyle='#1a4a1a';R.lineWidth=1;
  for(let i=1;i<=4;i++){R.beginPath();R.arc(c,c,r*i/4,0,7);R.stroke();}
  R.beginPath();R.moveTo(c,10);R.lineTo(c,W-10);R.moveTo(10,c);R.lineTo(W-10,c);R.stroke();
  // луч
  ang=(ang+0.04)%(2*Math.PI);
  const g=R.createLinearGradient(c,c,c+r*Math.cos(ang),c+r*Math.sin(ang));
  g.addColorStop(0,'rgba(80,255,80,0.0)');g.addColorStop(1,'rgba(80,255,80,0.8)');
  R.strokeStyle=g;R.lineWidth=3;R.beginPath();R.moveTo(c,c);R.lineTo(c+r*Math.cos(ang),c+r*Math.sin(ang));R.stroke();
  // уровень движения — круг в центре
  if(d){
    const lv=Math.min(d.level,3);
    const rr=20+lv*r*0.3;
    R.fillStyle=lv>1?`rgba(255,${Math.max(0,160-lv*50)},60,0.35)`:'rgba(80,255,80,0.25)';
    R.beginPath();R.arc(c,c,rr,0,7);R.fill();
    // при движении — бросаем "отметки" на луч
    if(lv>1&&Math.random()<lv*0.3){blips.push({a:ang,r:r*(0.3+Math.random()*0.65),t:1});}
  }
  blips=blips.filter(b=>b.t>0);
  for(const b of blips){R.fillStyle=`rgba(255,220,80,${b.t})`;R.beginPath();R.arc(c+b.r*Math.cos(b.a),c+b.r*Math.sin(b.a),4,0,7);R.fill();b.t-=0.01;}
  R.fillStyle='#5f5';R.font='13px monospace';
  if(d)R.fillText('RSSI '+d.rssi+' dBm   кадров '+d.frames,12,W-14);
  requestAnimationFrame(drawRadar);
}
function drawHist(){
  const W=420,Hh=110;H.fillStyle='#071007';H.fillRect(0,0,W,Hh);
  if(!d)return;const h=d.hist,mx=Math.max(d.thr*3,...h)*1.05;
  const y=v=>Hh-4-(v/mx)*(Hh-8);
  H.strokeStyle='#a55';H.setLineDash([4,4]);H.beginPath();H.moveTo(0,y(d.thr));H.lineTo(W,y(d.thr));H.stroke();H.setLineDash([]);
  H.strokeStyle='#5f5';H.lineWidth=2;H.beginPath();
  h.forEach((v,i)=>{const x=i*W/(h.length-1);i?H.lineTo(x,y(v)):H.moveTo(x,y(v));});H.stroke();
}
function drawSpec(){
  const W=420,Hh=110;S.fillStyle='#071007';S.fillRect(0,0,W,Hh);
  if(!d||!d.amps.length)return;const a=d.amps,bw=W/a.length,mx=Math.max(...a)||1;
  a.forEach((v,i)=>{const hh=v/mx*(Hh-6);S.fillStyle=`hsl(${120-Math.min(120,v/mx*120)},90%,55%)`;S.fillRect(i*bw,Hh-hh,Math.max(1,bw-1),hh);});
}
async function poll(){
  try{
    const r=await fetch('/data',{cache:'no-store'});d=await r.json();
    const st=document.getElementById('st'),al=document.getElementById('alarm');
    st.textContent=(d.calib?'КАЛИБРОВКА — не двигайся… ':'')+'уровень '+d.level.toFixed(2)+'  фон '+d.floor.toFixed(4)+'  порог '+d.thr.toFixed(4);
    if(d.calib){al.textContent='';}
    else if(d.level>2){al.style.color='#f44';al.textContent='ДВИЖЕНИЕ!';}
    else if(d.level>1){al.style.color='#fc3';al.textContent='шевеление';}
    else{al.style.color='#5f5';al.textContent='тихо';}
    drawHist();drawSpec();
  }catch(e){document.getElementById('st').textContent='нет связи с платой…';}
  setTimeout(poll,100);
}
drawRadar();poll();
</script></body></html>)HTML";
