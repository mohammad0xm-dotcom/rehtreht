/* CardScan core: parsing, consensus, xlsx writer. Pure functions, also run by test.js in Node. */
const P=(()=>{
const CONF=60,VOTES=3; /* confidence gate uses the all-digit account line only: Tesseract scores any line with asterisks as 0, even when read correctly */
/* lines: OCR lines of the guide region, top to bottom. Layout rule: masked card line, account line directly below. */
function parse(lines){
 const L=lines.map((l,k)=>({t:(l.text||'').replace(/\s+/g,''),c:l.confidence||0,k})).filter(l=>l.t);
 const r={acct:null,last4:null,conf:0,ci:-1,ai:-1};
 for(let i=0;i<L.length;i++){
  const m=/^(\d{6})(\D{2,12})(\d{4})$/.exec(L[i].t);
  if(!m)continue;
  r.last4=m[3];r.conf=L[i].c;r.ci=L[i].k;
  const a=L[i+1];
  if(a&&/^\d{7}$/.test(a.t)){r.acct=a.t;r.conf=a.c;r.ai=a.k}
  break;
 }
 return r;
}
const good=r=>!!(r&&r.acct&&r.last4&&r.conf>=CONF);
function voter(){
 const v={};let seen=0,part=null;
 return{
  add(r){
   if(r&&(r.acct||r.last4)){seen++;if(r.conf>=CONF)part=r}
   if(good(r)){const k=r.acct+'|'+r.last4;v[k]=(v[k]||0)+1}
   const e=Object.entries(v).sort((a,b)=>b[1]-a[1]);
   if(e[0]&&e[0][1]>=VOTES&&!(e[1]&&e[1][1]>=2)){const[a,l]=e[0][0].split('|');return{acct:a,last4:l}}
   return null;
  },
  get seen(){return seen},get part(){return part}};
}
/* ---- image helpers: pure functions on grayscale Uint8Array buffers (W*H) ---- */
const cl=v=>v<0?0:v>255?255:v;
function stretch(g){const n=g.length,h=new Uint32Array(256);for(let i=0;i<n;i++)h[g[i]]++;
 let lo=0,hi=255,s=0;while(lo<255&&(s+=h[lo])<n*.02)lo++;s=0;while(hi>0&&(s+=h[hi])<n*.02)hi--;
 const q=Math.max(hi-lo,1),o=new Uint8Array(n);for(let i=0;i<n;i++)o[i]=cl((g[i]-lo)*255/q);return o}
function sharpen(g,W,H){const o=g.slice();for(let y=1;y<H-1;y++)for(let x=1;x<W-1;x++){const i=y*W+x;o[i]=cl(5*g[i]-g[i-1]-g[i+1]-g[i-W]-g[i+W])}return o}
/* rotate content clockwise by deg about the centre (white fill) */
function rotate(g,W,H,deg){const a=deg*Math.PI/180,cs=Math.cos(a),sn=Math.sin(a),cx=W/2,cy=H/2,o=new Uint8Array(W*H).fill(255);
 for(let y=0;y<H;y++)for(let x=0;x<W;x++){const dx=x-cx,dy=y-cy,sx=cs*dx+sn*dy+cx,sy=-sn*dx+cs*dy+cy;if(sx<0||sy<0||sx>=W-1||sy>=H-1)continue;
  const x0=sx|0,y0=sy|0,fx=sx-x0,fy=sy-y0,i=y0*W+x0;o[y*W+x]=g[i]*(1-fx)*(1-fy)+g[i+1]*fx*(1-fy)+g[i+W]*(1-fx)*fy+g[i+W+1]*fx*fy}return o}
function resize(g,W,H,nw,nh){const o=new Uint8Array(nw*nh),kx=(W-1)/Math.max(nw-1,1),ky=(H-1)/Math.max(nh-1,1);
 for(let y=0;y<nh;y++){const sy=y*ky,y0=sy|0,y1=Math.min(y0+1,H-1),fy=sy-y0;for(let x=0;x<nw;x++){const sx=x*kx,x0=sx|0,x1=Math.min(x0+1,W-1),fx=sx-x0;
  o[y*nw+x]=g[y0*W+x0]*(1-fx)*(1-fy)+g[y0*W+x1]*fx*(1-fy)+g[y1*W+x0]*(1-fx)*fy+g[y1*W+x1]*fx*fy}}return o}
function crop(g,W,x0,y0,x1,y1){const w=x1-x0,h=y1-y0,o=new Uint8Array(w*h);for(let y=0;y<h;y++)o.set(g.subarray((y0+y)*W+x0,(y0+y)*W+x1),y*w);return o}
function half(g,W,H){const w=W>>1,h=H>>1,o=new Uint8Array(w*h);for(let y=0;y<h;y++)for(let x=0;x<w;x++){const i=2*y*W+2*x;o[y*w+x]=(g[i]+g[i+1]+g[i+W]+g[i+W+1])>>2}return o}
/* scale to width nw (averages 2x2 blocks first when shrinking a lot, so thin strokes survive) */
function fit(g,W,H,nw){let w=W,h=H;while(w/2>=nw*1.2){g=half(g,w,h);w>>=1;h>>=1}const nh=Math.max(1,Math.round(h*nw/w));return{g:resize(g,w,h,nw,nh),W:nw,H:nh}}
/* ---- two-stage reading. ocr(g,W,H,digitsOnly) -> lines [{text,confidence,bbox,baseline}].
   Measured on a test image: this OCR drops digits unpredictably depending on scale, so every read is tried at several scales. Dropped digits fail the strict format check; they are never filled in. */
async function verify(ocr,rb,W,H,s,L,r){ /* stage B: re-crop only the two lines from the full-resolution frame, deskew by their baseline, re-read at two sizes; no conflicting read allowed, at least one must agree */
 const c=L[r.ci],a=L[r.ai];if(!c||!a||!c.bbox||!a.bbox)return false;
 const h=Math.max(8,(c.bbox.y1-c.bbox.y0)/s),X0=Math.min(c.bbox.x0,a.bbox.x0)/s,X1=Math.max(c.bbox.x1,a.bbox.x1)/s,
 x0=Math.max(0,Math.round(X0-h*2)),x1=Math.min(W,Math.round(X1+h*2)),y0=Math.max(0,Math.round(c.bbox.y0/s-h*1.2)),y1=Math.min(H,Math.round(a.bbox.y1/s+h*1.2)),cw=x1-x0,ch=y1-y0;
 if(cw<20||ch<20)return false;
 const cr=crop(rb,W,x0,y0,x1,y1),b=c.baseline,ang=b&&b.x1>b.x0?Math.atan2(b.y1-b.y0,b.x1-b.x0)*180/Math.PI:0,
 angs=Math.abs(ang)>.5&&Math.abs(ang)<25?[-ang,0,ang]:[0];let agree=0;
 for(const th of[27,51]){
  for(const d of angs){
   const f=fit(rotate(cr,cw,ch,d),cw,ch,Math.round(cw*th/h)),g=sharpen(f.g,f.W,f.H),r2=parse(await ocr(g,f.W,f.H,true));
   if(good(r2)){if(r2.acct!==r.acct||r2.last4!==r.last4)return false;agree++;break}}}
 return agree>0}
/* tilt (degrees, clockwise positive) of the text lines found by a geometry pass; def if none usable */
function tilt(L,def){const a=[];for(const l of L){const b=l.baseline,q=l.bbox;if(!b||!q||b.x1<=b.x0||(q.x1-q.x0)<2.5*(q.y1-q.y0)||(l.text||'').trim().length<6)continue;a.push(Math.atan2(b.y1-b.y0,b.x1-b.x0)*180/Math.PI)}
 if(!a.length)return def;a.sort((x,y)=>x-y);const m=a[a.length>>1];return Math.abs(m)<=25?m:def}
/* F={g,W,H} gray frame. st={ang,armed,last}. Returns null (nothing seen) or {r,pair,img}; pair is set only if stage A and stage B agree.
   Geometry pass (all characters allowed) measures the tilt, the frame is straightened, then digits are read at several sizes. */
async function read(ocr,F,st){
 const{W,H}=F,base=stretch(F.g);let a=st.ang;
 if(st.armed){const f=fit(base,W,H,650);a=-tilt(await ocr(f.g,f.W,f.H,false),-st.ang);if(Math.abs(a)<1)a=0}
 /* ladder: straightened frame and unrotated frame, several sizes. The first attempt that shows the card/account layout is verified (stage B). */
 const T=st.armed?[[a,650],[0,650],[a,400],[0,400],[a,500],[a,800],[-4,650],[4,650]].filter((x,i,A)=>A.findIndex(y=>y[0]===x[0]&&y[1]===x[1])===i):[[st.ang,650]];
 let best=null;
 for(const[ra,w]of T){
  const rb=ra?rotate(base,W,H,ra):base,f=fit(rb,W,H,w),g=sharpen(f.g,f.W,f.H),L=await ocr(g,f.W,f.H,true),r=parse(L);st.last=L;
  if(!(r.acct||r.last4))continue;
  const o={r,pair:null,img:g,W:f.W,H:f.H,ra};
  if(good(r)&&await verify(ocr,rb,W,H,f.W/W,L,r)){o.pair={acct:r.acct,last4:r.last4};st.ang=ra;return o}
  if(!best||(good(r)&&!good(best.r)))best=o}   /* partial or unverified: keep trying other sizes/angles; never accepted */
 if(best)st.ang=best.ra;
 return best}
/* duplicate policy: an identical account+last4 pair is kept (never lost) but marked 'dup' and left out of the Excel file */
const classify=(keys,acct,last4)=>keys.has(acct+'|'+last4)?'dup':'ok';
const T=new Uint32Array(256).map((_,n)=>{let c=n;for(let k=0;k<8;k++)c=c&1?0xEDB88320^(c>>>1):c>>>1;return c>>>0});
function crc(u){let c=-1;for(let i=0;i<u.length;i++)c=T[(c^u[i])&255]^(c>>>8);return(c^-1)>>>0}
const u16=x=>[x&255,x>>8&255],u32=x=>[x&255,x>>8&255,x>>16&255,x>>>24];
function zip(files){ /* store-only zip */
 const e=new TextEncoder(),out=[],cen=[];let off=0;
 for(const[name,d]of files){
  const n=e.encode(name),c=crc(d),s=d.length;
  out.push(new Uint8Array([...u32(0x04034b50),...u16(20),...u16(0),...u16(0),...u16(0),...u16(0x21),...u32(c),...u32(s),...u32(s),...u16(n.length),...u16(0)]),n,d);
  cen.push(new Uint8Array([...u32(0x02014b50),...u16(20),...u16(20),...u16(0),...u16(0),...u16(0),...u16(0x21),...u32(c),...u32(s),...u32(s),...u16(n.length),...u16(0),...u16(0),...u16(0),...u16(0),...u32(0),...u32(off)]),n);
  off+=30+n.length+s;
 }
 const cs=cen.reduce((a,b)=>a+b.length,0);
 out.push(...cen,new Uint8Array([...u32(0x06054b50),...u16(0),...u16(0),...u16(files.length),...u16(files.length),...u32(cs),...u32(off),...u16(0)]));
 return new Blob(out,{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
}
/* rows: [[account,last4],...] as strings. Every cell is a text cell (style 1 = format "@"). */
function xlsx(rows){
 const e=new TextEncoder(),H='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',N='http://schemas.openxmlformats.org/',
 R='application/vnd.openxmlformats-officedocument.spreadsheetml.',
 c=(r,k,v)=>`<c r="${k}${r}" t="inlineStr" s="1"><is><t>${v}</t></is></c>`;
 const x=[H+`<worksheet xmlns="${N}spreadsheetml/2006/main"><cols><col min="1" max="2" width="18" customWidth="1"/></cols><sheetData>`,
  `<row r="1">${c(1,'A','Account Number')}${c(1,'B','Last 4 Card Digits')}</row>`];
 rows.forEach((r,i)=>x.push(`<row r="${i+2}">${c(i+2,'A',r[0])}${c(i+2,'B',r[1])}</row>`));
 x.push('</sheetData></worksheet>');
 const f=[
  ['[Content_Types].xml',H+`<Types xmlns="${N}package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="${R}sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="${R}worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="${R}styles+xml"/></Types>`],
  ['_rels/.rels',H+`<Relationships xmlns="${N}package/2006/relationships"><Relationship Id="rId1" Type="${N}officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
  ['xl/workbook.xml',H+`<workbook xmlns="${N}spreadsheetml/2006/main" xmlns:r="${N}officeDocument/2006/relationships"><sheets><sheet name="Cards" sheetId="1" r:id="rId1"/></sheets></workbook>`],
  ['xl/_rels/workbook.xml.rels',H+`<Relationships xmlns="${N}package/2006/relationships"><Relationship Id="rId1" Type="${N}officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${N}officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
  ['xl/styles.xml',H+`<styleSheet xmlns="${N}spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`],
  ['xl/worksheets/sheet1.xml',x.join('')]
 ].map(([n,s])=>[n,e.encode(s)]);
 return zip(f);
}
return{parse,good,voter,xlsx,zip,CONF,VOTES,stretch,sharpen,rotate,resize,crop,fit,tilt,read,verify,classify};
})();
if(typeof module!=='undefined')module.exports=P;
