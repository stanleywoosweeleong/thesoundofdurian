/* 敲榴莲 · The Sound of Durian
   A field-experiment tool. It does NOT claim lab-grade ripeness. It compares a
   tapped fruit's low-frequency knock resonance against the farmer's own basket of
   naturally-dropped (=100% ripe) references, and reports closeness as a RANGE plus
   a plain confidence word — never a fake decimal. Everything is on-device.
   ------------------------------------------------------------------------------- */
const CACHE_VERSION='tsod-20260710-10';
const LS_KEY='tsod_v1';
const MIN_REFS=10;          // target baseline; matching stays honest below this
const OFFER_MATCH_AT=3;     // refuse to guess with fewer than this many refs
const SENS_MIN=1, SENS_MAX=8, SENS_DEF=3;  // tap sensitivity (soft-tap gain): higher = fainter taps register
const ONSET_ABS=0.03;       // absolute knock floor at sensitivity 1; divided by the sensitivity setting
const RECORDER_IDLE_RELEASE=120000; // keep the mic stream alive up to 2 min between taps, then release

/* ---------- tiny helpers ---------- */
const $=(s,r=document)=>r.querySelector(s);
const $$=(s,r=document)=>[...r.querySelectorAll(s)];
const isEN=()=>document.body.classList.contains('lang-en');
const T=(zh,en)=>isEN()?en:zh;
function toast(zh,en){const t=$('#toast');t.textContent=T(zh,en);t.classList.add('show');clearTimeout(t._t);t._t=setTimeout(()=>t.classList.remove('show'),2400);}
function uid(){return Date.now().toString(36)+Math.random().toString(36).slice(2,7);}

/* ---------- persistent store ---------- */
let store={refs:[], tool:'', gain:SENS_DEF};
function load(){try{const s=JSON.parse(localStorage.getItem(LS_KEY));if(s&&typeof s==='object'){store=Object.assign(store,s);}}catch(e){}}
function save(){try{localStorage.setItem(LS_KEY,JSON.stringify(store));}catch(e){toast('存储失败，可能空间已满','Save failed — storage may be full');}}
load();

/* =====================================================================
   AUDIO CORE
   ===================================================================== */
const LOW_LO=80, LOW_HI=1200;   // fruit-body resonance band (Hz). Birds/wind sit above.
const WIN_MS=250;               // analysis window after the onset
const NBANDS=24;                // compact log-spaced envelope resolution

let audioCtx=null;
function ac(){audioCtx=audioCtx||new (window.AudioContext||window.webkitAudioContext)();return audioCtx;}

/* Hands-free recorder: start() opens the mic and records until stop() is called
   (or a safety cap is reached). This lets the farmer press once, set the phone
   down / hold the fruit, tap it with a hard object using both hands free, then
   press again to stop. Returns the captured mono Float32 clip. */
const Recorder={
  active:false, _stream:null, _src:null, _proc:null, _chunks:[], _frames:0,
  _resolve:null, _capMs:15000, _startedAt:0, _autoTimer:null,
  _persistStream:null, _releaseTimer:null,
  // Acquire the mic once and REUSE it across taps. iOS standalone PWAs re-prompt on
  // each getUserMedia call, so re-requesting per tap nags the worker all day. We hold
  // one live stream during a work bout and release it after a couple of idle minutes
  // (or on pagehide) so the recording indicator doesn't linger and battery is spared.
  async _getStream(){
    if(this._persistStream && this._persistStream.getTracks().some(t=>t.readyState==='live')) return this._persistStream;
    this._persistStream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false,channelCount:1}});
    return this._persistStream;
  },
  releaseStream(){
    clearTimeout(this._releaseTimer); this._releaseTimer=null;
    if(this._persistStream){ try{ this._persistStream.getTracks().forEach(t=>t.stop()); }catch(_){} }
    this._persistStream=null;
  },
  async start(opts){
    if(this.active) return;
    const autoCapture = !opts || opts.autoCapture!==false;
    clearTimeout(this._releaseTimer); this._releaseTimer=null;   // cancel any pending mic release
    this._stream=await this._getStream();                        // reuse the live mic stream if we have one
    const ctx=ac(); if(ctx.state==='suspended') await ctx.resume();
    this._src=ctx.createMediaStreamSource(this._stream);
    this._proc=ctx.createScriptProcessor(2048,1,1);
    this._chunks=[]; this._frames=0; this._sr=ctx.sampleRate; this._startedAt=Date.now();
    const capFrames=Math.ceil(ctx.sampleRate*this._capMs/1000);
    // --- realtime auto-stop: end the session shortly after the first clean knock
    //     so the farmer needn't press Stop. A tap is a sharp jump well above the
    //     ambient floor; once heard we keep just enough tail for a full analysis
    //     window, then stop. Manual Stop and the 15s safety cap still apply. ---
    this._autoCapture=autoCapture;
    this._onKnock=(opts&&opts.onKnock)||null;   // confidence gate; null = stop on first clean knock
    this._floor=0; this._floorInit=false; this._tapDetected=false; this._captureUntilFrame=0; this._tapCount=0;
    const postFrames=Math.ceil(ctx.sampleRate*(WIN_MS+90)/1000);
    // Tap sensitivity (soft-tap gain): a higher setting lowers both the absolute knock
    // floor and how far a tap must rise above ambient, so a gentle tap still registers —
    // far less fatigue over a full day. Match accuracy is unaffected: loudness is
    // normalised out downstream, so only detection gets easier, not the reading.
    const sens=Math.max(SENS_MIN,Math.min(SENS_MAX, store.gain||SENS_DEF));
    const absMin=ONSET_ABS/sens;
    const ratio=Math.max(1.8, 3.5-(sens-1)*0.25);
    const buildClip=()=>{ const out=new Float32Array(this._frames); let o=0; for(const c of this._chunks){out.set(c,o);o+=c.length;} return out; };
    liveAnalyser.attach(this._src,ctx);
    this._proc.onaudioprocess=(e)=>{
      const d=e.inputBuffer.getChannelData(0);
      this._chunks.push(new Float32Array(d)); this._frames+=d.length;
      if(this._autoCapture && !this._tapDetected){
        let e2=0; for(let j=0;j<d.length;j++){const v=d[j];e2+=v*v;}
        const rms=Math.sqrt(e2/d.length);
        if(!this._floorInit){ this._floor=rms+1e-6; this._floorInit=true; }
        else if(rms < this._floor*2){ this._floor=this._floor*0.9+rms*0.1; } // adapt on quiet frames only
        if(this._floorInit && rms>absMin && rms>this._floor*ratio){ // knock: clears the sensitivity-scaled floor AND rises above ambient
          this._tapDetected=true;
          this._captureUntilFrame=this._frames+postFrames;        // let the decay window fill, then judge
        }
      }
      if(this._tapDetected && this._frames>=this._captureUntilFrame){
        this._tapCount++;
        // Ask the caller whether we now have enough to decide. No callback (e.g.
        // baseline recording) means "one clean knock is enough". A confidence-driven
        // caller can keep us listening for a cleaner / closer knock.
        let done=true;
        if(this._onKnock){ try{ done=!!this._onKnock(buildClip(), this._tapCount); }catch(_){ done=true; } }
        if(done){ this.stop(false); return; }
        this._tapDetected=false;   // not confident yet — keep listening
      }
      if(this._frames>=capFrames) this.stop(true); // safety auto-stop
    };
    this._src.connect(this._proc); this._proc.connect(ctx.destination);
    this.active=true;
    // safety timeout as well (in case audio thread stalls)
    this._autoTimer=setTimeout(()=>{ if(this.active) this.stop(true); }, this._capMs+500);
    return new Promise((res)=>{ this._resolve=res; });
  },
  stop(auto){
    if(!this.active) return;
    this.active=false;
    clearTimeout(this._autoTimer);
    try{this._proc.onaudioprocess=null;this._src.disconnect();this._proc.disconnect();}catch(_){}
    // Keep the mic stream alive for reuse; release only after an idle gap so we don't
    // re-prompt between taps (full release also happens on pagehide).
    clearTimeout(this._releaseTimer);
    this._releaseTimer=setTimeout(()=>this.releaseStream(), RECORDER_IDLE_RELEASE);
    liveAnalyser.detach();
    const out=new Float32Array(this._frames); let o=0;
    for(const c of this._chunks){out.set(c,o);o+=c.length;}
    const clip={samples:out, sampleRate:this._sr, autoStopped:!!auto, tapCaptured:(this._tapCount>0)||!!this._tapDetected, durMs:Date.now()-this._startedAt};
    const r=this._resolve; this._resolve=null; this._chunks=[];
    if(r) r(clip);
  }
};

/* Scan the whole clip for the single strongest tap onset (the farmer may tap a
   few times during a hands-free session; we analyse the cleanest hit).
   The natural gesture is tap-then-press-stop, so the loudest hit often sits right
   at the tail with too few samples left for a full analysis window. We therefore
   prefer the strongest onset that STILL leaves a complete window after it, and
   only fall back to the overall strongest when the whole clip is too short. */
function findBestOnset(x, sr){
  const win=256, hop=128;
  const need = sr ? Math.floor(sr*WIN_MS/1000) : 0; // samples an analysis window needs after the onset
  let prev=1e-9, best=0, bestIdx=0, bestFull=0, bestFullIdx=-1;
  for(let i=0;i+win<x.length;i+=hop){
    let e=0; for(let j=0;j<win;j++){const v=x[i+j];e+=v*v;}
    e=Math.sqrt(e/win);
    const rise=e-prev;
    if(rise>best){best=rise;bestIdx=i;}
    if(rise>bestFull && i+need<=x.length){bestFull=rise;bestFullIdx=i;}
    prev=e;
  }
  if(bestFullIdx>=0) return {idx:bestFullIdx, strength:bestFull};
  return {idx:bestIdx, strength:best};
}

/* Peak absolute amplitude & rough noise floor (pre-onset RMS) for quality/SNR. */
function signalQuality(x,onsetIdx,sr){
  let peak=1e-9; for(let i=0;i<x.length;i++){const a=Math.abs(x[i]);if(a>peak)peak=a;}
  // noise floor = RMS of the 120ms BEFORE the onset (ambient: birds, wind)
  const pre0=Math.max(0,onsetIdx-Math.floor(sr*0.12));
  let nf=0,n=0; for(let i=pre0;i<onsetIdx;i++){nf+=x[i]*x[i];n++;}
  nf=Math.sqrt(nf/Math.max(1,n))+1e-9;
  const snr=20*Math.log10(peak/nf); // dB
  return {peak, snr};
}

/* Hann-windowed DFT magnitude over the low band only, returned as a log-spaced,
   L2-normalised envelope vector. Loudness is normalised out so only timbre/shape
   remains — that's what separates a dull ripe knock from a tight unripe one. */
function lowBandEnvelope(x, start, sr){
  const N=Math.min(Math.floor(sr*WIN_MS/1000), x.length-start);
  if(N<256) return null;
  // Hann window
  const w=new Float32Array(N);
  for(let i=0;i<N;i++){const s=x[start+i]*(0.5-0.5*Math.cos(2*Math.PI*i/(N-1)));w[i]=s;}
  // log-spaced band edges across LOW_LO..LOW_HI
  const edges=new Float32Array(NBANDS+1);
  for(let b=0;b<=NBANDS;b++){edges[b]=LOW_LO*Math.pow(LOW_HI/LOW_LO,b/NBANDS);}
  const bands=new Float32Array(NBANDS);
  // Goertzel-style direct evaluation at each band centre (cheap, N small)
  for(let b=0;b<NBANDS;b++){
    const f=Math.sqrt(edges[b]*edges[b+1]); // geometric centre
    const k=2*Math.PI*f/sr; let re=0,im=0;
    for(let i=0;i<N;i++){re+=w[i]*Math.cos(k*i);im-=w[i]*Math.sin(k*i);}
    bands[b]=Math.sqrt(re*re+im*im)/N;
  }
  // spectral descriptors within the low band
  let sum=0,cen=0; for(let b=0;b<NBANDS;b++){const f=Math.sqrt(edges[b]*edges[b+1]);sum+=bands[b];cen+=bands[b]*f;}
  const centroid=sum>1e-9?cen/sum:0;
  let peakB=0,peakV=0; for(let b=0;b<NBANDS;b++){if(bands[b]>peakV){peakV=bands[b];peakB=b;}}
  const peakFreq=Math.sqrt(edges[peakB]*edges[peakB+1]);
  // L2 normalise the envelope
  let norm=0; for(let b=0;b<NBANDS;b++)norm+=bands[b]*bands[b]; norm=Math.sqrt(norm)+1e-12;
  const env=Array.from(bands,v=>v/norm);
  return {env, centroid, peakFreq};
}

/* Decay rate: how fast energy falls after the onset (ripe/soft flesh damps faster). */
function decayRate(x,start,sr){
  const seg=Math.floor(sr*WIN_MS/1000); const half=Math.floor(seg/2);
  if(start+seg>x.length) return 0;
  let e1=0,e2=0;
  for(let i=0;i<half;i++){const a=x[start+i];e1+=a*a;}
  for(let i=half;i<seg;i++){const a=x[start+i];e2+=a*a;}
  e1=Math.sqrt(e1/half)+1e-9; e2=Math.sqrt(e2/half)+1e-9;
  return Math.log(e1/e2); // >0 means decaying
}

/* Full feature vector for one recorded clip. Returns null if no clear tap found. */
function extractFeatures(clip){
  const {samples:x, sampleRate:sr}=clip;
  const on=findBestOnset(x, sr);
  const q=signalQuality(x,on.idx,sr);
  const lb=lowBandEnvelope(x,on.idx,sr);
  if(!lb) return null;
  return {
    env:lb.env, centroid:lb.centroid, peakFreq:lb.peakFreq,
    decay:decayRate(x,on.idx,sr),
    snr:q.snr, onsetStrength:on.strength, sr
  };
}

/* Distance between two feature vectors. Envelope cosine distance dominates;
   centroid & decay add timbral context. All scaled to roughly 0..1. */
function featureDistance(a,b){
  // cosine distance on the L2-normalised envelopes
  let dot=0; for(let i=0;i<a.env.length;i++)dot+=a.env[i]*b.env[i];
  const cos=Math.max(-1,Math.min(1,dot));
  const dEnv=1-cos;                        // 0 identical .. 2 opposite (usually <1)
  const dCen=Math.min(1,Math.abs(a.centroid-b.centroid)/600);   // 600Hz spread → 1
  const dDec=Math.min(1,Math.abs(a.decay-b.decay)/2.5);
  return 0.68*dEnv + 0.20*dCen + 0.12*dDec;
}

/* Mean + spread of the reference cluster's pairwise self-distance — a tight,
   consistent baseline earns higher confidence than a scattered one. */
function clusterStats(refs){
  const fs=refs.map(r=>r.feat);
  if(fs.length<2) return {tightness:0.5};
  let sum=0,n=0,max=0;
  for(let i=0;i<fs.length;i++)for(let j=i+1;j<fs.length;j++){
    const d=featureDistance(fs[i],fs[j]);sum+=d;n++;if(d>max)max=d;
  }
  const mean=sum/n;
  // tightness 1 (very consistent) .. 0 (scattered). ~0.25 mean dist = loose.
  const tightness=Math.max(0,Math.min(1,1-mean/0.35));
  return {meanDist:mean, maxDist:max, tightness};
}

/* THE MATCH. Compares a tapped fruit to the drop-fruit baseline and returns an
   honest closeness RANGE + confidence tier. Never a single fake number. */
function matchAgainstBaseline(feat){
  const refs=store.refs.filter(r=>r.feat);
  if(refs.length<OFFER_MATCH_AT){
    return {status:'insufficient', have:refs.length};
  }
  // distance to each reference; use the k nearest to resist one odd ref
  const dists=refs.map(r=>featureDistance(feat,r.feat)).sort((a,b)=>a-b);
  const k=Math.min(5,dists.length);
  const near=dists.slice(0,k);
  const dNear=near.reduce((a,b)=>a+b,0)/k;

  const cl=clusterStats(refs);

  // Re-anchor closeness to the baseline's OWN spread. A fruit whose nearest ref is
  // within the cluster's typical internal distance sounds "as ripe as a drop-fruit";
  // one several spreads away sounds progressively less so. This keeps the read
  // honest whether the farmer's taps are naturally tight or loose.
  const spread=Math.max(0.06, cl.meanDist||0.15);       // baseline's own scale
  const rel=dNear/spread;                               // 0 = dead centre, 1 = edge of cluster
  // closeness: at/inside the cluster → high; a few spreads out → drops off.
  // (Anchor: within one internal spread → ~100%; each further spread costs ~42%.)
  let center=Math.round(100*Math.max(0,1-Math.max(0,rel-1)*0.42));
  center=Math.max(30,Math.min(99,center)); // never claim 100% (a real drop-fruit) or <30

  // --- confidence: honest blend of (sample count, cluster tightness, tap SNR,
  //     nearest-ref agreement, AND how far — in cluster-relative terms — the fruit sits) ---
  const nScore=Math.min(1,refs.length/MIN_REFS);              // 10 refs = full
  const snrScore=Math.max(0,Math.min(1,(feat.snr-6)/18));     // 6dB poor .. 24dB clean
  const agree=Math.max(0,Math.min(1,1-(near[near.length-1]-near[0])/(spread*1.5))); // nearest refs agree?
  const tight=cl.tightness;
  // Extrapolation gate (relative): within ~1 spread → fully "known"; beyond ~2.5
  // spreads the app is extrapolating past its baseline and must not be confident.
  const proximity=Math.max(0,Math.min(1,1-(rel-1)/1.8));
  const conf=0.26*nScore + 0.24*snrScore + 0.16*agree + 0.14*tight + 0.20*proximity;

  // range half-width widens as confidence drops → visually honest uncertainty
  const half=Math.round(3 + (1-conf)*11);   // ±3 (sure) .. ±14 (unsure)
  let lo=Math.max(25,center-half), hi=Math.min(99,center+half);

  let tier = conf>=0.66 ? 'hi' : conf>=0.42 ? 'mid' : 'lo';
  // hard honesty gates that override a rosy blended score:
  if(feat.snr<9 && tier==='hi') tier='mid';           // noisy tap can't be "high"
  if(rel>2.0 && tier==='hi') tier='mid';              // clearly outside baseline
  if(rel>3.2) tier='lo';                              // very far → openly unsure

  return {status:'ok', center, lo, hi, conf, tier, refs:refs.length, snr:feat.snr, dNear};
}

/* =====================================================================
   LIVE VISUAL — the signature. Draws the incoming waveform onto the stage
   canvas while recording, then freezes on the captured tap.
   ===================================================================== */
const liveAnalyser={
  node:null, raf:null, ctx2d:null, canvas:null,
  init(){
    this.canvas=$('#stageCanvas'); if(!this.canvas) return;
    try{ this.ctx2d=this.canvas.getContext('2d'); }catch(e){ this.ctx2d=null; }
    if(!this.ctx2d) return;
    this.resize(); window.addEventListener('resize',()=>{try{this.resize();this.idle();}catch(e){}}); this.idle();
  },
  resize(){
    const c=this.canvas; if(!c||!this.ctx2d) return;
    const r=c.getBoundingClientRect();
    const w=Math.max(1, r.width||c.clientWidth||320);
    const dpr=Math.min(2,window.devicePixelRatio||1);
    c.width=w*dpr; c.height=172*dpr; this.ctx2d.setTransform(dpr,0,0,dpr,0,0); this._w=w; this._h=172;
  },
  attach(src,ctx){const an=ctx.createAnalyser();an.fftSize=1024;an.smoothingTimeConstant=0.55;src.connect(an);this.node=an;this._buf=new Uint8Array(an.fftSize);this.loop();},
  detach(){this.node=null;},
  loop(){
    if(!this.ctx2d) return;
    const draw=()=>{
      this.raf=requestAnimationFrame(draw);
      const g=this.ctx2d,w=this._w,h=this._h; g.clearRect(0,0,w,h);
      if(!this.node){return;}
      this.node.getByteTimeDomainData(this._buf);
      // low-band emphasis mirror trace
      g.lineWidth=2; g.strokeStyle='#8fd0a8'; g.beginPath();
      const N=this._buf.length, mid=h*0.5;
      for(let i=0;i<N;i++){const v=(this._buf[i]-128)/128;const x=i/N*w;const y=mid+v*mid*0.82;i?g.lineTo(x,y):g.moveTo(x,y);}
      g.stroke();
      // soft glow baseline
      g.strokeStyle='rgba(127,160,106,.28)';g.lineWidth=1;g.beginPath();g.moveTo(0,mid);g.lineTo(w,mid);g.stroke();
    };
    cancelAnimationFrame(this.raf);draw();
  },
  idle(){
    if(!this.ctx2d) return;
    cancelAnimationFrame(this.raf);
    const g=this.ctx2d,w=this._w,h=this._h;g.clearRect(0,0,w,h);
    const mid=h*0.5;g.strokeStyle='rgba(127,160,106,.35)';g.lineWidth=1.5;g.beginPath();
    for(let x=0;x<=w;x+=2){const y=mid+Math.sin(x/26)*3*Math.exp(-Math.abs(x-w/2)/220);x?g.lineTo(x,y):g.moveTo(x,y);}
    g.stroke();
  },
  freeze(feat){ // paint the captured low-band envelope as bars
    if(!this.ctx2d) return;
    cancelAnimationFrame(this.raf);
    const g=this.ctx2d,w=this._w,h=this._h;g.clearRect(0,0,w,h);
    const env=feat.env,n=env.length,bw=w/n,base=h*0.86;
    let mx=Math.max(...env)||1;
    for(let i=0;i<n;i++){const bh=(env[i]/mx)*(h*0.62);g.fillStyle=i/n<0.5?'#8fd0a8':'#e8a94b';g.fillRect(i*bw+1,base-bh,bw-2,bh);}
    g.strokeStyle='rgba(246,239,223,.25)';g.beginPath();g.moveTo(0,base);g.lineTo(w,base);g.stroke();
  }
};

/* =====================================================================
   UI WIRING
   ===================================================================== */
function setStage(tagZh,tagEn,big,small){
  $('#stageTag').innerHTML=`<span class="zh">${tagZh}</span><span class="en">${tagEn}</span>`;
  $('#stageBig').textContent=big??'—';
  $('#stageSmall').textContent=small||'';
}

/* --- Baseline (refs) rendering --- */
function renderRefs(){
  const pips=$('#refPips'); pips.innerHTML='';
  for(let i=0;i<MIN_REFS;i++){
    const on=i<store.refs.length;
    const d=document.createElement('div');d.className='refpip'+(on?' on':'');d.textContent=on?'✓':(i+1);
    pips.appendChild(d);
  }
  const extra=store.refs.length>MIN_REFS?` (+${store.refs.length-MIN_REFS})`:'';
  const cnt=document.createElement('div');cnt.className='refcount';cnt.textContent=`${store.refs.length}/${MIN_REFS}${extra}`;
  pips.appendChild(cnt);

  const rs=$('#refStatus');
  if(store.refs.length===0){
    rs.innerHTML=T('还没有基准。先去捡自然落果的榴莲，敲进来。','No baseline yet. Gather naturally-dropped durians and tap them in.');
  }else if(store.refs.length<OFFER_MATCH_AT){
    rs.innerHTML=T(`再录 ${OFFER_MATCH_AT-store.refs.length} 颗，才够开始比对。`,`${OFFER_MATCH_AT-store.refs.length} more before matching can begin.`);
  }else if(store.refs.length<MIN_REFS){
    const cl=clusterStats(store.refs);
    rs.innerHTML=T(`已可比对，但样本偏少。基准一致度：${Math.round(cl.tightness*100)}%。凑够 10 颗更稳。`,`Matching enabled, but samples are few. Baseline consistency: ${Math.round(cl.tightness*100)}%. Reach 10 for steadier reads.`);
  }else{
    const cl=clusterStats(store.refs);
    rs.innerHTML=T(`基准完整（${store.refs.length} 颗）。一致度：${Math.round(cl.tightness*100)}%。想更准可用下方按钮继续加录，多多益善。`,`Baseline complete (${store.refs.length}). Consistency: ${Math.round(cl.tightness*100)}%. Keep tapping in more with the button below — the more drop-fruit, the steadier.`);
  }
  // Keep the "record another" button obviously live even past the 10 target.
  const rrb=$('#refRecBtn');
  if(rrb){
    const rlab=rrb.querySelector('span:last-child');
    if(rlab) rlab.innerHTML = store.refs.length>=MIN_REFS
      ? T('再加录一颗（可选，越多越准）','Record another (optional — more = steadier)')
      : (store.refs.length>0 ? T('再录一颗落果基准','Record another reference')
                             : T('开始录一颗落果基准','Start recording a reference'));
    rrb._idleLabel=null; // force doRecord to re-cache this fresh label
  }

  const list=$('#refList'); list.innerHTML='';
  if(store.refs.length===0){
    list.innerHTML=`<div class="empty">${T('基准库是空的','Baseline is empty')}</div>`;
  }else{
    store.refs.slice().reverse().forEach((r)=>{
      const row=document.createElement('div');row.className='refrow';
      const dt=new Date(r.ts);
      row.innerHTML=`<canvas class="mini" width="104" height="68"></canvas>
        <div class="meta"><b>#${r.n}</b><small>${r.tool?r.tool+' · ':''}${dt.toLocaleDateString()} · ${T('峰频','peak')} ${Math.round(r.feat.peakFreq)}Hz · SNR ${r.feat.snr.toFixed(0)}dB</small></div>
        <button class="del" data-del="${r.id}" aria-label="delete">🗑</button>`;
      list.appendChild(row);
      drawMini(row.querySelector('.mini'),r.feat);
    });
    $$('[data-del]',list).forEach(b=>b.onclick=()=>{
      if(!confirm(T('删除这颗基准？','Delete this reference?')))return;
      store.refs=store.refs.filter(x=>x.id!==b.dataset.del);save();renderRefs();renderTestGate();
    });
  }
}
function drawMini(cv,feat){
  const g=cv.getContext('2d');g.clearRect(0,0,cv.width,cv.height);
  const env=feat.env,n=env.length,bw=cv.width/n,base=cv.height-3,mx=Math.max(...env)||1;
  for(let i=0;i<n;i++){const bh=(env[i]/mx)*(cv.height-8);g.fillStyle=i/n<0.5?'#8fd0a8':'#e8a94b';g.fillRect(i*bw,base-bh,Math.max(1,bw-0.6),bh);}
}

/* gate shown on the Tap panel when baseline is too thin to match */
function renderTestGate(){
  const g=$('#testGate'); const nn=store.refs.length;
  if(nn>=OFFER_MATCH_AT){g.innerHTML='';return;}
  g.innerHTML=`<div class="verdict lo" style="margin-top:0;margin-bottom:12px">
    <div class="conf" style="color:var(--ink-soft)">${T('还不能比对','Matching not ready')}</div>
    <div class="why">${T(`需要至少 ${OFFER_MATCH_AT} 颗自然落果基准（目标 10）。现在有 ${nn} 颗。`,`Need at least ${OFFER_MATCH_AT} drop-fruit references (aim 10). You have ${nn}.`)}
    <br><button class="btn wide" style="margin-top:10px" id="gotoRefs">${T('去建立基准库 →','Build the baseline →')}</button></div></div>`;
  $('#gotoRefs').onclick=()=>switchTab('refs');
}

/* --- recording flows (press to start, press again to stop) --- */
let busy=false;               // guards the async stop→process phase
let recTimer=null;

function setRecUI(btn, state){
  // state: 'idle' | 'recording'
  const lab=btn.querySelector('span:last-child');
  if(state==='recording'){
    btn.classList.add('armed');
    lab.innerHTML=btn._recLabel || (btn.id==='refRecBtn'
      ? T('敲击中… 完成后按停止','Tapping… press stop when done')
      : T('敲击中… 完成后按停止','Tapping… press stop when done'));
  }else{
    btn.classList.remove('armed');
    lab.innerHTML=btn._idleLabel;
  }
}

async function doRecord(btn, purpose){
  // ---- STOP branch: a session is running and this press ends it ----
  if(Recorder.active){
    clearInterval(recTimer); recTimer=null;
    const lab=btn.querySelector('span:last-child');
    lab.innerHTML=`<span class="zh">分析中…</span><span class="en">Analysing…</span>`;
    Recorder.stop();   // resolves the start() promise; START branch processes the clip
    return;
  }

  // ---- START branch: begin a hands-free session ----
  if(busy) return;
  btn._idleLabel=btn._idleLabel||btn.querySelector('span:last-child').innerHTML;
  try{
    if(purpose==='test'){ setStage('聆听中','listening','●',T('敲果身…','tap the fruit…')); }
    const startPromise=Recorder.start(purpose==='test' ? {onKnock:evaluateKnock} : {});
    setRecUI(btn,'recording');
    // live elapsed counter in the button
    let t0=Date.now();
    recTimer=setInterval(()=>{
      const s=((Date.now()-t0)/1000).toFixed(1);
      const lab=btn.querySelector('span:last-child');
      lab.innerHTML=`<span class="zh">敲击中 ${s}s · 按停止</span><span class="en">Tapping ${s}s · press stop</span>`;
      if(purpose==='test') $('#stageSmall').textContent=T('敲果身… '+s+'s','tap… '+s+'s');
    },100);

    const clip=await startPromise;     // resolves when stop() is called (or safety cap)
    clearInterval(recTimer); recTimer=null;
    busy=true;
    setRecUI(btn,'idle');
    if(clip.autoStopped) toast(T('已到录音上限，自动停止','Reached recording cap — stopped'),'');
    else if(clip.tapCaptured) toast(T('已捕捉到一记敲击','Clean knock captured'),'');
    await processClip(btn, purpose, clip);
  }catch(err){
    clearInterval(recTimer); recTimer=null;
    Recorder.active=false;
    toast(T('无法使用麦克风，请检查权限','Microphone unavailable — check permission'),'');
    if(purpose==='test'){liveAnalyser.idle();setStage('待机','idle','—','');}
    setRecUI(btn,'idle');
  }finally{
    busy=false;
  }
}

/* Confidence-driven auto-stop. After each detected knock we extract features from
   the audio so far and test the match. Return true to STOP (we have a trustworthy
   read), false to keep listening for a cleaner / closer knock. Ceiling at 4 taps so
   the session always ends; manual Stop and the 15s cap remain backstops. */
function evaluateKnock(clipSoFar, tapCount){
  let feat; try{ feat=extractFeatures({samples:clipSoFar, sampleRate:Recorder._sr}); }catch(e){ return true; }
  if(!feat) return false;                          // no clear tap yet — keep listening
  const m=matchAgainstBaseline(feat);
  if(m.status!=='ok') return true;                 // baseline too thin to decide — stop & show the gate
  if(m.tier==='hi') return true;                   // confident — done
  if(m.tier==='mid' && tapCount>=2) return true;   // moderate, and we've heard a couple — good enough
  if(tapCount>=4) return true;                      // stop waiting; show the best-effort read
  toast(T('再敲一下取准…','Tap again to firm it up…'),'');
  return false;                                    // keep listening
}

async function processClip(btn, purpose, clip){
  const feat=extractFeatures(clip);
  const sensOn=Math.max(SENS_MIN,Math.min(SENS_MAX, store.gain||SENS_DEF));
  if(!feat || feat.onsetStrength<0.004/sensOn){
    toast(T('没听到清晰的敲击，再试一次','No clear tap detected — try again'),'');
    if(purpose==='test'){liveAnalyser.idle();setStage('待机','idle','—','');}
    return;
  }
  if(purpose==='ref'){
    const n=(store.refs.reduce((m,r)=>Math.max(m,r.n),0))+1;
    const tool=($('#refTool').value||store.tool||'').trim();
    store.refs.push({id:uid(),n,ts:Date.now(),tool,feat});
    store.tool=tool; save();
    renderRefs(); renderTestGate();
    toast(T(`已存基准 #${n}`,`Saved reference #${n}`),'');
  }else{
    liveAnalyser.freeze(feat);
    showResult(feat);
  }
}

function showResult(feat){
  const box=$('#testResult');
  const m=matchAgainstBaseline(feat);
  if(m.status!=='ok'){
    setStage('样本不足','need more','—','');
    box.innerHTML=`<div class="verdict lo"><div class="conf">${T('样本不足，暂不猜','Too few refs — not guessing')}</div>
      <div class="why">${T(`只有 ${m.have} 颗基准，至少要 ${OFFER_MATCH_AT} 颗。`,`Only ${m.have} references; need ${OFFER_MATCH_AT}.`)}</div></div>`;
    return;
  }
  const confWord=m.tier==='hi'?T('把握度：高','Confidence: high'):m.tier==='mid'?T('把握度：中','Confidence: moderate'):T('把握度：低','Confidence: low');
  const confCol=m.tier==='hi'?'var(--good)':m.tier==='mid'?'var(--warn)':'var(--ink-soft)';
  setStage('结果','result',`${m.lo}–${m.hi}%`,T('接近落果','vs drop-fruit'));
  let why;
  if(m.tier==='lo'){
    why=T(`这次把握度低（基准 ${m.refs} 颗，信噪比 ${m.snr.toFixed(0)}dB）。可能是敲得不够干净、背景太吵，或基准还太少。建议换安静点重录、或多补几颗落果基准。别只凭这个数字决定 —— 割开、闻香、等落果才是定案。`,`Low confidence this time (${m.refs} refs, SNR ${m.snr.toFixed(0)}dB). The tap may be unclean, background too loud, or the baseline too small. Re-record somewhere quieter or add more drop-fruit refs. Don't decide on this number alone — cutting, aroma and natural drop are the real call.`);
  }else if(m.tier==='mid'){
    why=T(`中等把握（基准 ${m.refs} 颗）。这颗果的低频共振${m.center>=80?'比较接近':'还没很接近'}你的落果基准。多敲几下取一致的一下更稳。`,`Moderate confidence (${m.refs} refs). This fruit's low-frequency resonance is ${m.center>=80?'fairly close to':'not yet close to'} your drop-fruit baseline. A few consistent taps steady the read.`);
  }else{
    why=T(`把握度高（基准 ${m.refs} 颗，信噪比好）。声音${m.center>=85?'很接近':'与'}落果基准${m.center>=85?'':'仍有距离'}。仍建议割一颗验证，把结果记进你的经验。`,`High confidence (${m.refs} refs, clean tap). The sound is ${m.center>=85?'very close to':'still some distance from'} your drop-fruit baseline. Still cut one to verify and bank the result.`);
  }
  box.innerHTML=`<div class="verdict ${m.tier}">
    <div class="rng">${m.lo}–${m.hi}%</div>
    <div class="conf" style="color:${confCol}">${confWord}</div>
    <div class="why">${why}</div>
    <div class="btnrow"><button class="btn" id="againBtn">${T('再敲一次','Tap again')}</button></div>
  </div>`;
  $('#againBtn').onclick=()=>{box.innerHTML='';liveAnalyser.idle();setStage('待机','idle','—','');};
}

/* --- tabs / lang --- */
function switchTab(p){
  $$('nav.tabs button').forEach(b=>b.classList.toggle('active',b.dataset.p===p));
  $$('.panel').forEach(s=>s.classList.toggle('active',s.id===p));
  try{localStorage.setItem('tsod_tab',p);}catch(e){}
  window.scrollTo({top:0,behavior:'smooth'});
}
function initTabs(){
  $$('nav.tabs button').forEach(b=>b.onclick=()=>switchTab(b.dataset.p));
  let saved='test';try{saved=localStorage.getItem('tsod_tab')||'test';}catch(e){}
  if($('#'+saved))switchTab(saved);
}
function initLang(){
  let en=false;try{en=localStorage.getItem('tsod_lang')==='en';}catch(e){}
  document.body.classList.toggle('lang-en',en);
  $('#langBtn').textContent=en?'中文':'EN';
  $('#langBtn').onclick=()=>{
    const now=!document.body.classList.contains('lang-en');
    document.body.classList.toggle('lang-en',now);
    $('#langBtn').textContent=now?'中文':'EN';
    try{localStorage.setItem('tsod_lang',now?'en':'zh');}catch(e){}
    renderRefs();renderTestGate();
  };
}

function initSens(){
  const r=$('#sensRange'), v=$('#sensVal');
  if(!r) return;
  let g=Math.max(SENS_MIN,Math.min(SENS_MAX, store.gain||SENS_DEF));
  r.min=SENS_MIN; r.max=SENS_MAX; r.step=1; r.value=g;
  if(v) v.textContent=g+'×';
  r.oninput=()=>{ g=Math.max(SENS_MIN,Math.min(SENS_MAX, parseInt(r.value,10)||SENS_DEF)); store.gain=g; save(); if(v) v.textContent=g+'×'; };
}
function init(){
  // Wire the controls FIRST and each independently, so a failure in any one
  // (canvas, storage, a render) can never leave the buttons dead.
  try{ initLang(); }catch(e){ console.error('lang init',e); }
  try{ initTabs(); }catch(e){ console.error('tabs init',e); }
  try{
    const rb=$('#recBtn'); if(rb) rb.onclick=()=>doRecord(rb,'test');
    const fb=$('#refRecBtn'); if(fb) fb.onclick=()=>doRecord(fb,'ref');
  }catch(e){ console.error('rec wiring',e); }
  try{ if(store.tool && $('#refTool')) $('#refTool').value=store.tool; }catch(e){}
  try{ initSens(); }catch(e){ console.error('sens init',e); }
  try{ renderRefs(); renderTestGate(); }catch(e){ console.error('render',e); }
  try{ liveAnalyser.init(); setStage('待机','idle','—',''); }catch(e){ console.error('canvas init',e); }
  try{ const v=$('#verLine'); if(v) v.textContent=CACHE_VERSION; }catch(e){}
}
// Run after the DOM is parsed. The script tag sits at end-of-body, but guard
// anyway in case it's ever moved or the document isn't ready yet.
if(document.readyState==='loading'){
  document.addEventListener('DOMContentLoaded',init);
}else{
  init();
}

/* Release the mic when the app is truly backgrounded/closed so the recording
   indicator doesn't linger and battery is spared. */
window.addEventListener('pagehide',()=>{ try{Recorder.releaseStream();}catch(_){}} );

/* --- service worker (update-aware, mirrors durianripe pattern) --- */
if('serviceWorker' in navigator){
  let refreshing=false;
  navigator.serviceWorker.addEventListener('controllerchange',()=>{if(refreshing)return;refreshing=true;location.reload();});
  function updToast(worker){
    if($('#updToast'))return;
    const t=document.createElement('div');t.id='updToast';t.className='toast show';t.style.cssText+='display:flex;gap:12px;align-items:center;bottom:22px';
    t.innerHTML=`<span>${T('有新版本','New version')}</span>`;
    const b=document.createElement('button');b.textContent=T('更新','Update');
    b.style.cssText='border:none;background:var(--flesh);color:var(--shell);font-weight:800;border-radius:9px;padding:6px 12px;cursor:pointer';
    b.onclick=()=>{b.textContent=T('更新中…','Updating…');worker.postMessage({type:'SKIP_WAITING'});};
    t.appendChild(b);document.body.appendChild(t);
  }
  navigator.serviceWorker.register('sw.js').then(reg=>{
    if(reg.waiting&&navigator.serviceWorker.controller)updToast(reg.waiting);
    reg.addEventListener('updatefound',()=>{const nw=reg.installing;if(!nw)return;
      nw.addEventListener('statechange',()=>{if(nw.state==='installed'&&navigator.serviceWorker.controller)updToast(nw);});});
    document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')reg.update().catch(()=>{});});
  }).catch(()=>{});
}
