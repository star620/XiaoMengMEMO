// TASK-3 candidate: fixed final layout throughout the transform; no stylesheet changes.
(args => {
  try {
    const key = '__xmSizeTween';
    const props = ['position', 'right', 'top', 'width', 'height', 'transform', 'transform-origin', 'transition'];
    function signature(root) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const lines = [];
      const scale = root.getBoundingClientRect().width / root.offsetWidth;
      for (let node; (node = walker.nextNode());) {
        const range = document.createRange();
        let previous = null;
        const breaks = [];
        for (let i = 0; i < node.length; i++) {
          range.setStart(node, i); range.setEnd(node, i + 1);
          const rect = range.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) continue;
          const y = rect.top / scale;
          if (previous === null || Math.abs(y - previous) > 2) breaks.push(i);
          previous = y;
        }
        if (breaks.length) lines.push([node.textContent, breaks]);
      }
      return JSON.stringify(lines);
    }
    if (args.action === 'prepare') {
      const root = document.querySelector('.xm-note');
      if (!root) return {ok:false, error:'note root missing'};
      const visual = root.getBoundingClientRect();
      window[key]?.restore();
      const saved = props.map(p => [p, root.style.getPropertyValue(p), root.style.getPropertyPriority(p)]);
      const state = {
        root, started:0, signature:null,
        restore() { for (const [p,v,priority] of saved) v ? root.style.setProperty(p,v,priority) : root.style.removeProperty(p); }
      };
      Object.assign(root.style, {
        position:'absolute',right:'0px',top:'0px',width:args.width+'px',height:args.height+'px',
        transformOrigin:'100% 0%',transition:'none',
        transform:`scale(${visual.width / args.width},${visual.height / args.height})`
      });
      void root.offsetWidth;
      window[key] = state;
      return {ok:true};
    }
    const state = window[key];
    if (!state) return {ok:false,error:'missing prepared tween'};
    if (args.action === 'play') {
      state.signature = signature(state.root);
      state.root.style.transition = 'transform 120ms cubic-bezier(.22,.61,.36,1)';
      state.root.style.transform = 'scale(1,1)';
      state.started = performance.now();
      return {ok:true};
    }
    if (args.action === 'finish') {
      const during = signature(state.root);
      state.restore();
      const final = signature(state.root);
      delete window[key];
      return {ok:true, wrap_match:state.signature === during && during === final,
        elapsed_ms:performance.now()-state.started, width:state.root.offsetWidth,height:state.root.offsetHeight};
    }
    state.restore(); delete window[key];
    return {ok:true};
  } catch (error) { return {ok:false,error:String(error)}; }
})
