(function(){
  "use strict";

  var SERIES_VARS = {
    blue:'--series-blue', orange:'--series-orange', orchid:'--series-orchid', aqua:'--series-aqua',
    rust:'--series-rust', yellow:'--series-yellow', wine:'--series-wine', indigo:'--series-indigo',
    magenta:'--series-magenta', green:'--series-green', violet:'--series-violet', red:'--series-red'
  };
  // Fixed order = the CVD-safety mechanism (validated adjacent-pair pass in both
  // themes, node scripts/validate_palette.js from the dataviz skill). The 4 new
  // hues (orchid, rust, wine, indigo) are inserted at the specific positions this
  // validated against — don't reorder without re-running the validator.
  var COLOR_ORDER = ['blue','orange','orchid','aqua','rust','yellow','wine','indigo','magenta','green','violet','red'];

  // Public by design: RLS in supabase/schema.sql is what protects the data.
  var SUPABASE_URL = 'https://mhvrrnwktunexctmtuok.supabase.co';
  var SUPABASE_KEY = 'sb_publishable_o__aY4s8WzgkVOP9ePm5BA_amzGRnfJ';

  var HORIZON_MONTHS = 168; // 14 years
  var ID_RE = /^[a-z0-9-]{1,64}$/;
  var MAX_AMOUNT = 999999999999;

  var sb = null;
  var householdId = null;
  var userEmail = null;
  var goals = [];
  var assumptions = { capacity:0, liquid:0, returnPct:0, fx:318 };

  // Unsaved local changes, keyed 'a' (assumptions), 'g:<id>' (upsert), 'd:<id>' (delete).
  // Kept until the server confirms, so a failed save can be retried and a
  // partner's live update never overwrites something you haven't saved yet.
  var dirty = {};
  var inFlight = 0;
  var lastError = null;

  // ---------- Mapping + validation (server data is untrusted input) ----------
  function num(v, max){
    var n = Number(v);
    if(!isFinite(n) || n < 0) return 0;
    return Math.min(n, max == null ? MAX_AMOUNT : max);
  }
  function goalFromRow(r){
    if(!r || !ID_RE.test(String(r.id))) return null;
    return {
      id: String(r.id),
      color: COLOR_ORDER.indexOf(r.color) !== -1 ? r.color : 'blue',
      name: String(r.name || 'Untitled fund').slice(0, 120),
      type: r.type === 'reserve' ? 'reserve' : 'purchase',
      floor: !!r.floor,
      targetAmount: num(r.target_amount),
      alreadySaved: num(r.already_saved),
      targetDate: /^\d{4}-\d{2}-\d{2}$/.test(r.target_date) ? r.target_date : isoDate(new Date()),
      notes: String(r.notes || '').slice(0, 2000)
    };
  }
  function goalToRow(g){
    return {
      household_id: householdId, id: g.id, color: g.color, name: g.name, type: g.type,
      floor: g.floor, target_amount: g.targetAmount, already_saved: g.alreadySaved,
      target_date: g.targetDate, notes: g.notes
    };
  }
  function assumptionsFromRow(r){
    return { capacity: num(r.capacity), liquid: num(r.liquid), returnPct: num(r.return_pct, 20), fx: num(r.fx) || 318 };
  }
  function isoDate(d){
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  // ---------- Status + errors ----------
  function setStatus(state, text){
    var pill = document.getElementById('statusPill');
    pill.setAttribute('data-state', state);
    document.getElementById('statusText').textContent = text;
  }
  function refreshStatus(){
    var pending = Object.keys(dirty).length;
    if(!navigator.onLine && pending) setStatus('offline', 'Offline — ' + pending + ' unsaved');
    else if(lastError) setStatus('error', 'Couldn’t save');
    else if(inFlight || pending) setStatus('saving', 'Saving…');
    else setStatus('synced', 'Saved');
  }
  function showError(msg){
    document.getElementById('errorText').textContent = msg;
    document.getElementById('errorBanner').hidden = !msg;
    document.getElementById('retryBtn').hidden = false;
  }
  function describeError(err){
    if(!navigator.onLine) return 'You’re offline. Your changes are kept on this page and will save when you reconnect.';
    return 'Couldn’t save to your shared plan (' + ((err && err.message) || 'unknown error') + '). Your changes are kept on this page — retry, and don’t close this tab until it says Saved.';
  }

  // ---------- Writes ----------
  // One request per key at a time: an edit made while that key is saving is
  // queued ('again') and sent after, so saves can't land out of order.
  function mark(key){
    dirty[key] = (dirty[key] === 'sending' || dirty[key] === 'again') ? 'again' : true;
    flush();
  }
  function markGoal(goal){ if(!dirty['d:' + goal.id]) mark('g:' + goal.id); }
  function markDeleted(id){ if(dirty['g:' + id] !== 'sending' && dirty['g:' + id] !== 'again') delete dirty['g:' + id]; mark('d:' + id); }
  function markAssumptions(){ mark('a'); }

  function flush(){
    lastError = null;
    showError('');
    Object.keys(dirty).forEach(function(key){
      if(dirty[key] === 'sending' || dirty[key] === 'again') return;
      var req;
      if(key === 'a'){
        req = sb.from('assumptions').update({
          capacity: assumptions.capacity, liquid: assumptions.liquid,
          return_pct: assumptions.returnPct, fx: assumptions.fx
        }).eq('household_id', householdId).select('household_id');
      } else if(key.indexOf('g:') === 0){
        var g = goals.find(function(x){ return x.id === key.slice(2); });
        if(!g){ delete dirty[key]; return; }
        req = sb.from('goals').upsert(goalToRow(g)).select('id');
      } else {
        req = sb.from('goals').delete().eq('household_id', householdId).eq('id', key.slice(2));
      }
      dirty[key] = 'sending';
      inFlight++;
      req.then(function(res){
        inFlight--;
        // An update that RLS filters out returns no rows and no error.
        var blocked = !res.error && key.indexOf('d:') !== 0 && !(res.data && res.data.length);
        if(res.error || blocked){
          dirty[key] = true;
          lastError = res.error || {message:'no permission to change this plan'};
          showError(describeError(lastError));
        } else if(dirty[key] === 'again'){
          dirty[key] = true;
          flush();
        } else {
          delete dirty[key];
        }
        refreshStatus();
      }, function(err){
        inFlight--;
        dirty[key] = true;
        lastError = err;
        showError(describeError(err));
        refreshStatus();
      });
    });
    refreshStatus();
  }

  // ---------- Reads ----------
  function fetchAll(){
    return Promise.all([
      sb.from('assumptions').select('*').eq('household_id', householdId).maybeSingle(),
      sb.from('goals').select('*').eq('household_id', householdId)
    ]).then(function(res){
      if(res[0].error) throw res[0].error;
      if(res[1].error) throw res[1].error;
      if(!res[0].data) throw new Error('This household has no assumptions row yet — see README.md setup step 3.');
      var serverGoals = res[1].data.map(goalFromRow).filter(Boolean);
      // Keep anything you've changed locally but not yet saved.
      var localById = {};
      goals.forEach(function(g){ localById[g.id] = g; });
      var merged = serverGoals.filter(function(g){ return !dirty['d:' + g.id]; }).map(function(g){
        return dirty['g:' + g.id] && localById[g.id] ? localById[g.id] : g;
      });
      goals.forEach(function(g){
        if(dirty['g:' + g.id] && !merged.some(function(m){ return m.id === g.id; })) merged.push(g);
      });
      goals = merged;
      if(!dirty.a) assumptions = assumptionsFromRow(res[0].data);
    });
  }

  function css(varName){
    return getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  }

  function fmtUSD(n){
    var sign = n < 0 ? '-' : '';
    return sign + '$' + Math.round(Math.abs(n)).toLocaleString('en-US');
  }
  function fmtCompact(n){
    var sign = n < 0 ? '−' : '';
    var a = Math.abs(n);
    if(a >= 1000000) return sign + '$' + (a/1000000).toFixed(a % 1000000 === 0 ? 0 : 1) + 'M';
    if(a >= 1000) return sign + '$' + Math.round(a/1000) + 'K';
    return sign + '$' + Math.round(a);
  }
  function fmtMonthYear(d){
    return d.toLocaleDateString('en-US', {month:'short', year:'numeric'});
  }
  function capitalize(s){ return s.charAt(0).toUpperCase() + s.slice(1); }
  function escapeHtml(s){
    return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
    });
  }

  function monthsFromNow(dateStr){
    var now = new Date();
    var t = new Date(dateStr + 'T00:00:00');
    var m = (t.getFullYear() - now.getFullYear()) * 12 + (t.getMonth() - now.getMonth());
    return Math.max(1, m);
  }

  function addMonths(date, n){
    var d = new Date(date.getFullYear(), date.getMonth() + n, 1);
    return d;
  }

  function derive(){
    var now = new Date();
    var today = isoDate(now);
    var withCalc = goals.map(function(g){
      var monthsLeft = monthsFromNow(g.targetDate);
      var remaining = Math.max(0, g.targetAmount - (g.alreadySaved || 0));
      var monthlyRequired = remaining / monthsLeft;
      // Past its date: whatever's unfunded is due now. Flagged rather than
      // silently shown like a goal that's simply due next month.
      var overdue = g.targetDate < today;
      return Object.assign({}, g, {monthsLeft:monthsLeft, remaining:remaining, monthlyRequired:monthlyRequired, overdue:overdue});
    });
    var totalRequired = withCalc.reduce(function(s,g){ return s + g.monthlyRequired; }, 0);
    var overdueGoals = withCalc.filter(function(g){ return g.overdue && g.remaining > 0; });
    var overdueRequired = overdueGoals.reduce(function(s,g){ return s + g.monthlyRequired; }, 0);
    var gap = assumptions.capacity - totalRequired;
    return {now:now, goals:withCalc, totalRequired:totalRequired, gap:gap, overdueGoals:overdueGoals, overdueRequired:overdueRequired};
  }

  var state = derive();

  function syncInputs(){
    document.getElementById('in-capacity').value = assumptions.capacity;
    document.getElementById('in-liquid').value = assumptions.liquid;
    document.getElementById('in-return').value = assumptions.returnPct;
    document.getElementById('in-fx').value = assumptions.fx;
  }

  function renderSummary(){
    document.getElementById('statRequired').textContent = fmtUSD(state.totalRequired) + '/mo';
    var gapEl = document.getElementById('statGap');
    var noteEl = document.getElementById('statGapNote');
    gapEl.textContent = (state.gap >= 0 ? '+' : '') + fmtUSD(state.gap) + '/mo';
    noteEl.innerHTML = '';
    var dot = document.createElement('span');
    var label = document.createElement('span');
    if(state.gap >= 0){
      dot.className = 'dot good';
      label.textContent = 'On track at this savings rate';
    } else {
      dot.className = 'dot critical';
      label.textContent = 'Short — raise savings, push out dates, or cut a goal';
    }
    noteEl.appendChild(dot);
    noteEl.appendChild(label);

    document.getElementById('statRequiredHuf').textContent =
      '≈ Ft ' + Math.round(state.totalRequired * assumptions.fx).toLocaleString('en-US') + '/mo at ' + assumptions.fx + ' HUF per USD';

    if(state.overdueGoals.length){
      var od = document.createElement('div');
      od.className = 'stat-note overdue';
      od.textContent = 'Includes ' + fmtUSD(state.overdueRequired) + '/mo from ' + state.overdueGoals.length +
        ' overdue goal' + (state.overdueGoals.length > 1 ? 's' : '') + ' — move the date or remove it.';
      noteEl.parentNode.querySelectorAll('.overdue').forEach(function(n){ n.remove(); });
      noteEl.parentNode.appendChild(od);
    } else {
      noteEl.parentNode.querySelectorAll('.overdue').forEach(function(n){ n.remove(); });
    }
  }

  // ---------- Balance chart ----------
  function renderBalanceChart(){
    var W = 880, H = 340, ML = 54, MR = 16, MT = 16, MB = 84;
    var plotW = W - ML - MR, plotH = H - MT - MB;

    var monthlyReturn = (assumptions.returnPct / 100) / 12;
    var series = [assumptions.liquid];
    var spendAt = {};
    state.goals.forEach(function(g){
      if(g.type === 'purchase' && !g.overdue && g.monthsLeft <= HORIZON_MONTHS){
        spendAt[g.monthsLeft] = (spendAt[g.monthsLeft] || 0) + g.targetAmount;
      }
    });
    var bal = assumptions.liquid;
    for(var m = 1; m <= HORIZON_MONTHS; m++){
      bal = bal * (1 + monthlyReturn) + assumptions.capacity;
      if(spendAt[m]) bal -= spendAt[m];
      series.push(bal);
    }

    var yMin = Math.min(0, Math.floor(Math.min.apply(null, series) / 10000) * 10000);
    var yMax = Math.ceil(Math.max.apply(null, series) / 10000) * 10000;
    if(yMax === yMin) yMax = yMin + 10000;

    function xFor(mo){ return ML + (mo / HORIZON_MONTHS) * plotW; }
    function yFor(v){ return MT + plotH - ((v - yMin) / (yMax - yMin)) * plotH; }

    var gridLines = '', gridLabels = '';
    var steps = 4;
    for(var i = 0; i <= steps; i++){
      var v = yMin + (yMax - yMin) * (i / steps);
      var y = yFor(v);
      gridLines += '<line class="grid-line" x1="'+ML+'" x2="'+(W-MR)+'" y1="'+y+'" y2="'+y+'"></line>';
      gridLabels += '<text class="axis-label" x="'+(ML-8)+'" y="'+(y+3)+'" text-anchor="end">'+fmtCompact(v)+'</text>';
    }

    var xLabels = '';
    var yearStep = HORIZON_MONTHS > 96 ? 24 : 12;
    for(var mo = 0; mo <= HORIZON_MONTHS; mo += yearStep){
      var d = addMonths(state.now, mo);
      xLabels += '<text class="axis-label" x="'+xFor(mo)+'" y="'+(MT+plotH+16)+'" text-anchor="middle">'+d.getFullYear()+'</text>';
    }

    var linePts = series.map(function(v, mo){ return xFor(mo)+','+yFor(v); }).join(' ');
    var zeroY = yFor(0);
    var areaPts = ML+','+zeroY+' '+linePts+' '+xFor(HORIZON_MONTHS)+','+zeroY;

    var milestoneMarks = '';
    var row = 0;
    state.goals.slice().sort(function(a,b){ return a.monthsLeft - b.monthsLeft; }).forEach(function(g, idx){
      if(g.overdue || g.monthsLeft > HORIZON_MONTHS) return;
      var x = xFor(g.monthsLeft);
      var colorVar = 'var(' + SERIES_VARS[g.color] + ')';
      if(g.type === 'purchase'){
        milestoneMarks += '<line x1="'+x+'" x2="'+x+'" y1="'+MT+'" y2="'+(MT+plotH)+'" stroke="'+colorVar+'" stroke-width="1.5" stroke-dasharray="3 3" opacity="0.55"></line>';
        var ly = MT + plotH + 30 + (row % 2) * 15;
        milestoneMarks += '<circle cx="'+x+'" cy="'+(MT+plotH+6)+'" r="3.5" fill="'+colorVar+'"></circle>';
        milestoneMarks += '<text class="axis-label" x="'+x+'" y="'+ly+'" text-anchor="middle" fill="var(--text-secondary)">'+escapeHtml(g.name)+'</text>';
        row++;
      } else {
        var y = yFor(series[g.monthsLeft]);
        milestoneMarks += '<rect x="'+(x-4)+'" y="'+(y-4)+'" width="8" height="8" transform="rotate(45 '+x+' '+y+')" fill="var(--surface)" stroke="'+colorVar+'" stroke-width="2"></rect>';
      }
    });

    var svg = ''+
      '<svg viewBox="0 0 '+W+' '+H+'" role="img" aria-label="Projected liquid savings over 14 years">'+
        '<line class="baseline-line" x1="'+ML+'" x2="'+(W-MR)+'" y1="'+zeroY+'" y2="'+zeroY+'"></line>'+
        gridLines +
        '<polygon points="'+areaPts+'" fill="var(--accent)" opacity="0.10"></polygon>'+
        '<polyline points="'+linePts+'" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"></polyline>'+
        milestoneMarks +
        gridLabels + xLabels +
        '<line id="balCrosshair" x1="0" x2="0" y1="'+MT+'" y2="'+(MT+plotH)+'" stroke="var(--text-muted)" stroke-width="1" opacity="0"></line>'+
        '<circle id="balCrossDot" r="4" fill="var(--accent)" stroke="var(--surface)" stroke-width="2" opacity="0"></circle>'+
        '<rect id="balOverlay" x="'+ML+'" y="'+MT+'" width="'+plotW+'" height="'+plotH+'" fill="transparent"></rect>'+
      '</svg>';

    var wrap = document.getElementById('balanceChartWrap');
    var tooltip = document.getElementById('balanceTooltip');
    wrap.innerHTML = svg;
    wrap.appendChild(tooltip);

    wrap._chart = {W:W, H:H, ML:ML, MR:MR, MT:MT, plotW:plotW, series:series, xFor:xFor, yFor:yFor};
  }

  function bindBalanceHover(){
    var wrap = document.getElementById('balanceChartWrap');
    var tooltip = document.getElementById('balanceTooltip');
    wrap.addEventListener('mousemove', function(e){
      var c = wrap._chart;
      if(!c) return;
      var svg = wrap.querySelector('svg');
      var rect = svg.getBoundingClientRect();
      var scale = c.W / rect.width;
      var svgX = (e.clientX - rect.left) * scale;
      var mo = Math.round(((svgX - c.ML) / c.plotW) * HORIZON_MONTHS);
      mo = Math.max(0, Math.min(HORIZON_MONTHS, mo));
      var val = c.series[mo];
      var x = c.xFor(mo), y = c.yFor(val);
      var cross = document.getElementById('balCrosshair');
      var dot = document.getElementById('balCrossDot');
      if(cross){ cross.setAttribute('x1', x); cross.setAttribute('x2', x); cross.setAttribute('opacity', 0.5); }
      if(dot){ dot.setAttribute('cx', x); dot.setAttribute('cy', y); dot.setAttribute('opacity', 1); }
      var d = addMonths(state.now, mo);
      tooltip.innerHTML = '<div class="t-title">'+fmtMonthYear(d)+'</div><div class="t-row"><span>Liquid balance</span><span>'+fmtUSD(val)+'</span></div>';
      tooltip.style.opacity = 1;
      tooltip.style.left = (x / c.W) * rect.width + 'px';
      tooltip.style.top = ((y / c.H) * rect.height) - 10 + 'px';
    });
    wrap.addEventListener('mouseleave', function(){
      var cross = document.getElementById('balCrosshair');
      var dot = document.getElementById('balCrossDot');
      if(cross) cross.setAttribute('opacity', 0);
      if(dot) dot.setAttribute('opacity', 0);
      tooltip.style.opacity = 0;
    });
  }

  // ---------- Stacked bar chart (per year) ----------
  function renderBarChart(){
    var W = 880, H = 300, ML = 54, MR = 16, MT = 16, MB = 34;
    var plotW = W - ML - MR, plotH = H - MT - MB;
    var startYear = state.now.getFullYear();
    var years = [];
    for(var y = startYear; y <= startYear + 13; y++) years.push(y);

    var offChart = [];
    var perYear = years.map(function(yr){
      var active = state.goals.filter(function(g){
        var gYear = new Date(g.targetDate + 'T00:00:00').getFullYear();
        return gYear >= yr;
      });
      return active;
    });

    state.goals.forEach(function(g){
      var gYear = new Date(g.targetDate + 'T00:00:00').getFullYear();
      if(gYear > years[years.length - 1]) offChart.push(g);
    });
    document.getElementById('offChartNote').textContent = offChart.length
      ? offChart.map(function(g){ return g.name + ' (target ' + g.targetDate.slice(0,4) + ')'; }).join(', ') + ' — beyond this chart’s 14-year window, but included in the totals above and the table below.'
      : '';

    var totals = perYear.map(function(list){
      return list.reduce(function(s,g){ return s + g.monthlyRequired; }, 0);
    });
    var yMax = Math.ceil(Math.max.apply(null, totals.concat([100])) / 500) * 500;

    function yFor(v){ return MT + plotH - (v / yMax) * plotH; }

    var gridLines = '', gridLabels = '';
    var steps = 4;
    for(var i = 0; i <= steps; i++){
      var v = yMax * (i / steps);
      var yy = yFor(v);
      gridLines += '<line class="grid-line" x1="'+ML+'" x2="'+(W-MR)+'" y1="'+yy+'" y2="'+yy+'"></line>';
      gridLabels += '<text class="axis-label" x="'+(ML-8)+'" y="'+(yy+3)+'" text-anchor="end">'+fmtCompact(v)+'/mo</text>';
    }

    var slot = plotW / years.length;
    var barW = Math.min(24, slot * 0.55);
    var bars = '';
    years.forEach(function(yr, idx){
      var cx = ML + slot * (idx + 0.5);
      var list = perYear[idx].slice().sort(function(a,b){ return COLOR_ORDER.indexOf(a.color) - COLOR_ORDER.indexOf(b.color); });
      var cum = 0;
      list.forEach(function(g){
        var segH = (g.monthlyRequired / yMax) * plotH;
        var top = yFor(cum + g.monthlyRequired);
        var drawH = Math.max(0, segH - 2);
        bars += '<rect data-year="'+yr+'" class="bar-seg" x="'+(cx - barW/2)+'" y="'+top+'" width="'+barW+'" height="'+drawH+'" fill="var('+SERIES_VARS[g.color]+')"></rect>';
        cum += g.monthlyRequired;
      });
      bars += '<rect class="bar-hit" data-year="'+yr+'" x="'+(cx - slot/2)+'" y="'+MT+'" width="'+slot+'" height="'+plotH+'" fill="transparent"></rect>';
      var showLabel = (idx % 2 === 0) || years.length <= 8;
      if(showLabel){
        gridLabels += '<text class="axis-label" x="'+cx+'" y="'+(MT+plotH+16)+'" text-anchor="middle">'+yr+'</text>';
      }
    });

    var svg = ''+
      '<svg viewBox="0 0 '+W+' '+H+'" role="img" aria-label="Monthly funding needed per year, by fund">'+
        gridLines + bars + gridLabels +
        '<line class="baseline-line" x1="'+ML+'" x2="'+(W-MR)+'" y1="'+(MT+plotH)+'" y2="'+(MT+plotH)+'"></line>'+
      '</svg>';

    var wrap = document.getElementById('barChartWrap');
    var tooltip = document.getElementById('barTooltip');
    wrap.innerHTML = svg;
    wrap.appendChild(tooltip);
    wrap._chart = {W:W, H:H, perYear:perYear, years:years};

    var legend = document.getElementById('legend');
    legend.innerHTML = state.goals.slice().sort(function(a,b){ return COLOR_ORDER.indexOf(a.color) - COLOR_ORDER.indexOf(b.color); }).map(function(g){
      return '<span class="legend-item"><span class="legend-swatch" style="background:var('+SERIES_VARS[g.color]+')"></span>'+escapeHtml(g.name)+'</span>';
    }).join('');
  }

  function bindBarHover(){
    var wrap = document.getElementById('barChartWrap');
    var tooltip = document.getElementById('barTooltip');
    wrap.addEventListener('mousemove', function(e){
      var t = e.target;
      if(!t || (!t.classList.contains('bar-hit'))) { tooltip.style.opacity = 0; return; }
      var c = wrap._chart;
      var yr = parseInt(t.getAttribute('data-year'), 10);
      var idx = c.years.indexOf(yr);
      var list = c.perYear[idx].slice().sort(function(a,b){ return COLOR_ORDER.indexOf(a.color) - COLOR_ORDER.indexOf(b.color); });
      var total = list.reduce(function(s,g){ return s + g.monthlyRequired; }, 0);
      var rows = list.map(function(g){
        return '<div class="t-row"><span><span class="swatch" style="background:var('+SERIES_VARS[g.color]+')"></span>'+escapeHtml(g.name)+'</span><span>'+fmtUSD(g.monthlyRequired)+'</span></div>';
      }).join('');
      tooltip.innerHTML = '<div class="t-title">'+yr+' — total '+fmtUSD(total)+'/mo</div>' + (rows || '<div class="t-row"><span>No active funds</span></div>');
      var svg = wrap.querySelector('svg');
      var rect = svg.getBoundingClientRect();
      var scale = c.W / rect.width;
      var svgX = (e.clientX - rect.left) * scale;
      tooltip.style.opacity = 1;
      tooltip.style.left = (svgX / c.W) * rect.width + 'px';
      tooltip.style.top = '0px';
    });
    wrap.addEventListener('mouseleave', function(){ tooltip.style.opacity = 0; });
  }

  // ---------- Table ----------
  function renderTable(){
    var tbody = document.getElementById('goalsTbody');
    tbody.innerHTML = state.goals.slice().sort(function(a,b){ return new Date(a.targetDate) - new Date(b.targetDate); }).map(function(g){
      var colorOptions = COLOR_ORDER.map(function(c){
        return '<option value="'+c+'"'+(c === g.color ? ' selected' : '')+'>'+capitalize(c)+'</option>';
      }).join('');
      return '<tr>'+
        '<td>'+
          '<div class="goal-name-row">'+
            '<span class="color-dot" style="background:var('+SERIES_VARS[g.color]+')"></span>'+
            '<select data-field="color" data-id="'+escapeHtml(g.id)+'" aria-label="Color">'+colorOptions+'</select>'+
            '<input type="text" data-field="name" data-id="'+escapeHtml(g.id)+'" value="'+escapeHtml(g.name)+'" aria-label="Fund name">'+
          '</div>'+
          '<textarea data-field="notes" data-id="'+escapeHtml(g.id)+'" rows="2" aria-label="Notes">'+escapeHtml(g.notes)+'</textarea>'+
          '<div class="row-controls">'+
            '<select data-field="type" data-id="'+escapeHtml(g.id)+'" aria-label="Type">'+
              '<option value="purchase"'+(g.type === 'purchase' ? ' selected' : '')+'>Purchase (spent)</option>'+
              '<option value="reserve"'+(g.type === 'reserve' ? ' selected' : '')+'>Reserve (held)</option>'+
            '</select>'+
            '<label><input type="checkbox" data-field="floor" data-id="'+escapeHtml(g.id)+'" '+(g.floor ? 'checked' : '')+'> Floor</label>'+
            '<button type="button" class="remove-btn" data-id="'+escapeHtml(g.id)+'">Remove</button>'+
          '</div>'+
        '</td>'+
        '<td class="num"><input type="number" step="500" min="0" data-field="targetAmount" data-id="'+escapeHtml(g.id)+'" value="'+g.targetAmount+'"></td>'+
        '<td class="num"><input class="already-input" type="number" step="500" min="0" data-field="alreadySaved" data-id="'+escapeHtml(g.id)+'" value="'+g.alreadySaved+'"></td>'+
        '<td><input type="date" data-field="targetDate" data-id="'+escapeHtml(g.id)+'" value="'+escapeHtml(g.targetDate)+'"></td>'+
        '<td class="num months-cell">'+(g.overdue ? '<span class="overdue">Overdue</span>' : g.monthsLeft)+'</td>'+
        '<td class="num req-cell">'+fmtUSD(g.monthlyRequired)+'</td>'+
      '</tr>';
    }).join('');

    tbody.querySelectorAll('[data-field]').forEach(function(input){
      input.addEventListener('change', function(){
        var id = input.getAttribute('data-id');
        var field = input.getAttribute('data-field');
        var goal = goals.find(function(g){ return g.id === id; });
        if(!goal) return;
        if(field === 'targetAmount' || field === 'alreadySaved'){
          goal[field] = num(parseFloat(input.value));
        } else if(field === 'targetDate'){
          if(/^\d{4}-\d{2}-\d{2}$/.test(input.value)) goal.targetDate = input.value;
        } else if(field === 'name'){
          goal.name = input.value.trim().slice(0, 120) || 'Untitled fund';
        } else if(field === 'notes'){
          goal.notes = input.value.slice(0, 2000);
        } else if(field === 'color'){
          if(COLOR_ORDER.indexOf(input.value) !== -1) goal.color = input.value;
        } else if(field === 'type'){
          goal.type = input.value === 'reserve' ? 'reserve' : 'purchase';
        } else if(field === 'floor'){
          goal.floor = input.checked;
        }
        markGoal(goal);
        renderAll();
      });
    });

    tbody.querySelectorAll('.remove-btn').forEach(function(btn){
      btn.addEventListener('click', function(){
        var id = btn.getAttribute('data-id');
        var goal = goals.find(function(g){ return g.id === id; });
        if(!goal || !confirm('Remove “' + goal.name + '” for both of you? This can’t be undone.')) return;
        goals = goals.filter(function(g){ return g.id !== id; });
        markDeleted(id);
        renderAll();
      });
    });
  }

  function addGoal(){
    var usedColors = goals.map(function(g){ return g.color; });
    var freeColor = COLOR_ORDER.filter(function(c){ return usedColors.indexOf(c) === -1; })[0];
    var nextColor = freeColor || COLOR_ORDER[goals.length % COLOR_ORDER.length];
    var id = 'goal-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    var d = addMonths(new Date(), 12);
    var dateStr = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-01';
    var goal = {
      id: id, color: nextColor, name: 'New fund', type: 'purchase', floor: false,
      targetAmount: 0, alreadySaved: 0, targetDate: dateStr, notes: ''
    };
    goals.push(goal);
    markGoal(goal);
    renderAll();
  }

  function renderAll(){
    state = derive();
    renderSummary();
    renderBalanceChart();
    renderBarChart();
    renderTable();
  }

  function bindAssumptionInputs(){
    [['in-capacity','capacity',MAX_AMOUNT],['in-liquid','liquid',MAX_AMOUNT],['in-return','returnPct',20],['in-fx','fx',MAX_AMOUNT]].forEach(function(f){
      document.getElementById(f[0]).addEventListener('change', function(e){
        var v = parseFloat(e.target.value);
        if(!isNaN(v) && v >= 0 && v <= f[2] && !(f[1] === 'fx' && v === 0)){
          assumptions[f[1]] = v;
          markAssumptions();
        }
        syncInputs();
        renderAll();
      });
    });
    document.getElementById('addFundBtn').addEventListener('click', addGoal);
    document.getElementById('retryBtn').addEventListener('click', function(){
      if(householdId) flush(); else boot();
    });
  }

  // ---------- Views ----------
  function showView(name){
    ['authView','loadingView','appView'].forEach(function(v){
      document.getElementById(v).hidden = v !== name;
    });
  }

  // ---------- Live updates from the other person ----------
  // Re-render is held while you're typing in a field, so their change
  // can't replace the input under your cursor.
  var pendingRemote = false, refetchTimer = null;
  function editing(){
    var el = document.activeElement;
    return !!(el && el.closest && el.closest('#appView') && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
  }
  function applyRemote(){
    if(editing()){ pendingRemote = true; return; }
    pendingRemote = false;
    syncInputs();
    renderAll();
  }
  function scheduleRefetch(){
    clearTimeout(refetchTimer);
    refetchTimer = setTimeout(function(){
      fetchAll().then(applyRemote, function(){ /* next event or reload will catch up */ });
    }, 250);
  }
  document.addEventListener('focusout', function(){
    setTimeout(function(){ if(pendingRemote) applyRemote(); }, 0);
  });

  var channel = null;
  function subscribe(){
    if(channel) sb.removeChannel(channel);
    channel = sb.channel('household-' + householdId)
      .on('postgres_changes', {event:'*', schema:'public', table:'goals', filter:'household_id=eq.' + householdId}, scheduleRefetch)
      .on('postgres_changes', {event:'*', schema:'public', table:'assumptions', filter:'household_id=eq.' + householdId}, scheduleRefetch)
      .subscribe();
  }

  // ---------- Auth + boot ----------
  var booting = false;
  function boot(){
    if(booting) return;
    booting = true;
    showError('');
    showView('loadingView');
    setStatus('saving', 'Loading…');
    sb.from('household_members').select('household_id').eq('email', userEmail).limit(1).then(function(res){
      if(res.error) throw res.error;
      if(!res.data.length){
        var e = new Error('“' + userEmail + '” isn’t on this plan yet. It needs adding as a household member in Supabase (README.md, setup step 2) — then tap Retry.');
        e.notMember = true;
        throw e;
      }
      householdId = res.data[0].household_id;
      return fetchAll();
    }).then(function(){
      booting = false;
      showView('appView');
      syncInputs();
      renderAll();
      refreshStatus();
      subscribe();
    }, function(err){
      booting = false;
      showView(null);
      setStatus('error', 'Couldn’t load');
      showError(err.notMember ? err.message : (navigator.onLine ? 'Couldn’t load your plan (' + (err.message || 'unknown error') + ').' : 'You’re offline — reconnect and retry.'));
    });
  }

  var verifying = false;
  function onSession(session){
    if(verifying && !session) return;  // don't flash the sign-in form while a link is being checked
    var email = session && session.user && session.user.email;
    document.getElementById('accountEmail').hidden = !email;
    document.getElementById('signOutBtn').hidden = !email;
    if(!email){
      householdId = null; userEmail = null; goals = []; dirty = {};
      if(channel){ sb.removeChannel(channel); channel = null; }
      showError('');
      showView('authView');
      setStatus('idle', 'Not signed in');
      return;
    }
    if(email.toLowerCase() === userEmail) return;
    userEmail = email.toLowerCase();
    document.getElementById('accountEmail').textContent = userEmail;
    boot();
  }

  function bindAuth(){
    document.getElementById('authForm').addEventListener('submit', function(e){
      e.preventDefault();
      var email = document.getElementById('authEmail').value.trim();
      var msg = document.getElementById('authMsg');
      var btn = document.getElementById('authSubmit');
      if(!email) return;
      btn.disabled = true;
      msg.textContent = 'Sending…';
      sb.auth.signInWithOtp({ email: email, options: { emailRedirectTo: location.origin + location.pathname } }).then(function(res){
        btn.disabled = false;
        msg.textContent = res.error
          ? 'Couldn’t send the link: ' + res.error.message
          : 'Check ' + email + ' for a sign-in link. Open it in this browser.';
      }, function(err){
        btn.disabled = false;
        msg.textContent = 'Couldn’t send the link: ' + ((err && err.message) || 'network error');
      });
    });
    document.getElementById('signOutBtn').addEventListener('click', function(){
      if(Object.keys(dirty).length && !confirm('Some changes haven’t saved yet. Sign out anyway and lose them?')) return;
      sb.auth.signOut();
    });
  }

  function start(){
    bindAssumptionInputs();
    bindBalanceHover();
    bindBarHover();
    bindAuth();
    window.addEventListener('online', function(){ if(householdId && Object.keys(dirty).length) flush(); else refreshStatus(); });
    window.addEventListener('offline', function(){ if(householdId) refreshStatus(); });
    window.addEventListener('beforeunload', function(e){
      if(Object.keys(dirty).length){ e.preventDefault(); e.returnValue = ''; }
    });
    if(!window.supabase || !window.supabase.createClient){
      showView('loadingView');
      setStatus('error', 'Couldn’t load');
      showError('Couldn’t load the database library — check your connection and reload.');
      document.getElementById('retryBtn').hidden = true;
      return;
    }
    sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });
    sb.auth.onAuthStateChange(function(event, session){
      // Supabase warns against awaiting other client calls inside this callback.
      setTimeout(function(){ onSession(session); }, 0);
    });
    verifyEmailLink();
  }

  // The email template links to ?token_hash=…&type=email (see
  // supabase/email-template.html). Verifying here instead of via Supabase's
  // redirect means the link works on any device, not just the requesting one.
  function verifyEmailLink(){
    var params = new URLSearchParams(location.search);
    var tokenHash = params.get('token_hash');
    if(!tokenHash) return;
    var type = params.get('type') || 'email';
    // One-time token: drop it from the address bar and history either way.
    history.replaceState(null, '', location.pathname + location.hash);
    verifying = true;
    showView('loadingView');
    setStatus('saving', 'Signing in…');
    sb.auth.verifyOtp({ token_hash: tokenHash, type: type }).then(function(res){
      verifying = false;
      if(res.error) linkFailed();
    }, function(){
      verifying = false;
      linkFailed();
    });
  }
  function linkFailed(){
    // Already signed in (e.g. clicked an old link again)? Just carry on.
    sb.auth.getSession().then(function(res){
      var session = res && res.data && res.data.session;
      onSession(session);
      if(!session){
        document.getElementById('authMsg').textContent =
          'That sign-in link has expired or was already used. Request a new one below.';
      }
    });
  }

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
