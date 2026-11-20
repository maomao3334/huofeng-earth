'use strict';
// The page cannot report its own unresponsive event loop. Monitor only during
// foreground interaction. One IndexedDB write per detected stall, no polling of disk.
let until=0, ack=0, context=null, timer=0, saved=false, db=null;
try {
  const open=indexedDB.open('le-render-health',1);
  open.onupgradeneeded=()=>open.result.createObjectStore('events');
  open.onsuccess=()=>{
    db=open.result;
    const req=db.transaction('events').objectStore('events').get('last');
    req.onsuccess=()=>{if(req.result)self.postMessage({type:'record',record:req.result});};
  };
} catch (_) {}
function tick(){
  const now=Date.now();
  if(now>until){clearInterval(timer);timer=0;return;}
  if(!saved && now-ack>=1200){
    saved=true;
    const record={at:new Date().toISOString(),mainThreadSilentMs:now-ack,context:context};
    try{if(db)db.transaction('events','readwrite').objectStore('events').put(record,'last');}catch(_){}
    self.postMessage({type:'record',record:record});
  }
  self.postMessage({type:'ping'});
}
self.onmessage=function(e){
  const m=e.data, now=Date.now();
  if(m.type==='disarm'||m.hidden){until=0;return;}
  if(m.type==='ack'){ack=now;return;}
  if(m.type==='arm'){
    if(!timer||now>until){ack=now;saved=false;}
    context=m;until=now+8000;
    if(!timer)timer=setInterval(tick,350);
  }
};
