// Configuration - Update SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY after setting up Supabase
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const CONFIG = {
  SUPABASE_URL: 'https://indewtgxmkdxaecynamm.supabase.co', // Replace with your Supabase project URL
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_KAlsObC8ClTx4BTY2rxvjQ_L_ECjpbT', // Replace with your Supabase publishable key
  TIMEZONE: 'America/Chicago',
  LABS: [
    'Master of Science in Robotics (MSR)', 'Robot Design Studio (RDS)', 'Lynch', 'Colgate', 'Rubenstein',
    'Argall', 'Truby', 'Hartmann', 'MacIver', 'Murphey', 'Peshkin', 'Elwin', 'Umbanhowar', 'Kriegman', 'Other'
  ],
  MATERIALS: ['PLA', 'TPU', 'PETG', 'PC', 'ABS/ASA', 'Multi-Material', 'Other']
};

// Initialize Supabase client
const supabase = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_PUBLISHABLE_KEY);

// Utilities
const fmtDateInput = (d) => d.toISOString().slice(0,10);
const pad2 = (n) => String(n).padStart(2,'0');
function minutesSinceMidnight(hhmm){
  const [h,m] = hhmm.split(':').map(Number); return h*60+m;
}
function hhmmFromMinutes(min){
  const h = Math.floor(min/60); const m = min%60; return `${pad2(h)}:${pad2(m)}`;
}
function clampTo30(hhmm){
  const m = minutesSinceMidnight(hhmm); const snapped = Math.round(m/30)*30; return hhmmFromMinutes(snapped);
}

// Get current date in Chicago timezone
function getCurrentDateInChicago(){
  const now = new Date();
  // Format date in Chicago timezone
  const chicagoDate = new Intl.DateTimeFormat('en-US', {
    timeZone: CONFIG.TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(now);
  
  const year = chicagoDate.find(p => p.type === 'year').value;
  const month = chicagoDate.find(p => p.type === 'month').value;
  const day = chicagoDate.find(p => p.type === 'day').value;
  
  return `${year}-${month}-${day}`;
}

// Format time from timestamp (handles timezone conversion to Chicago)
function formatTime(timestamp, timezone = 'America/Chicago') {
  const date = new Date(timestamp);
  // Convert to Chicago time
  const chicagoTime = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(date);
  
  const hour = chicagoTime.find(p => p.type === 'hour').value.padStart(2, '0');
  const minute = chicagoTime.find(p => p.type === 'minute').value.padStart(2, '0');
  return `${hour}:${minute}`;
}

// State
let state = {
  date: getCurrentDateInChicago(),
  reservations: [], // [{printer,start,end}]
  printers: [], // [{id, display_name, printer_type, status, notes}]
  selection: null,  // {printer, startMin, endMin}
  drag: null,        // {mode:'creating'|'resize-top'|'resize-bottom', printer, startMin, endMin}
  isScrolling: false // Track if user is currently scrolling
};

// Elements
const timeCol = document.getElementById('timeCol');
const printersWrap = document.getElementById('printers');
const printersHeader = document.getElementById('printersHeader');
const calendarEl = document.getElementById('calendar');
const loadingEl = document.getElementById('loading');
const datePicker = document.getElementById('datePicker');
const prevDayBtn = document.getElementById('prevDay');
const todayBtn = document.getElementById('todayBtn');
const nextDayBtn = document.getElementById('nextDay');

// Dialog elements
const dialog = document.getElementById('reservationDialog');
const form = document.getElementById('reservationForm');
const formError = document.getElementById('formError');
const resPrinter = document.getElementById('resPrinter');
const resDate = document.getElementById('resDate');
const resStart = document.getElementById('resStart');
const resDuration = document.getElementById('resDuration');
const resEndDisplay = document.getElementById('resEndDisplay');
const resName = document.getElementById('resName');
const resContact = document.getElementById('resContact');
const resLab = document.getElementById('resLab');
const resMaterial = document.getElementById('resMaterial');
const resLabOther = document.getElementById('resLabOther');
const resMaterialOther = document.getElementById('resMaterialOther');
const resNotes = document.getElementById('resNotes');

// Initialize controls
function initControls(){
  datePicker.value = state.date;
  datePicker.addEventListener('change', ()=>{ state.date = datePicker.value; refresh(); });
  prevDayBtn.addEventListener('click', ()=>{ shiftDate(-1); });
  todayBtn.addEventListener('click', ()=>{ 
    state.date = getCurrentDateInChicago(); 
    datePicker.value = state.date; 
    refresh().then(() => {
      // Scroll to current time after refresh completes
      setTimeout(() => {
        scrollToCurrentTime();
      }, 100);
    });
  });
  nextDayBtn.addEventListener('click', ()=>{ shiftDate(1); });
}
function shiftDate(delta){
  const d = new Date(state.date); d.setDate(d.getDate()+delta); state.date = fmtDateInput(d); datePicker.value = state.date; refresh();
}

function buildTimeColumn(){
  timeCol.innerHTML = '';
  // Add header spacer to align with printer column headers
  const header = document.createElement('div');
  header.className = 'time-col-header';
  timeCol.appendChild(header);
  // Add slots container
  const slots = document.createElement('div');
  slots.className = 'time-col-slots';
  for(let i=0;i<48;i++){
    const min = i*30; const h = Math.floor(min/60); const m = min%60;
    const el = document.createElement('div'); el.className='time';
    if(m===0){
      const textSpan = document.createElement('span');
      textSpan.className = 'time-text';
      // Convert to 12-hour format with AM/PM (Apple Calendar style)
      const hour12 = h === 0 ? 12 : (h > 12 ? h - 12 : h);
      const ampm = h < 12 ? 'AM' : 'PM';
      // Show "Noon" for 12 PM, otherwise just hour + AM/PM
      const timeText = (h === 12) ? 'Noon' : `${hour12} ${ampm}`;
      textSpan.textContent = timeText;
      el.appendChild(textSpan);
    }
    slots.appendChild(el);
  }
  timeCol.appendChild(slots);
}

function buildPrinters(){
  printersHeader.innerHTML = '';
  printersWrap.innerHTML = '';
  
  // Use operational printers from state
  const operationalPrinters = state.printers.filter(p => p.status === 'operational');
  
  operationalPrinters.forEach(pr => {
    // Header in separate row
    const head = document.createElement('div'); 
    head.className='printer-header';
    
    const nameDiv = document.createElement('div');
    nameDiv.className = 'printer-name';
    nameDiv.textContent = pr.display_name;
    head.appendChild(nameDiv);
    
    const typeDiv = document.createElement('div');
    typeDiv.className = 'printer-type';
    typeDiv.textContent = pr.printer_type;
    head.appendChild(typeDiv);
    
    printersHeader.appendChild(head);
    
    // Column with slots
    const col = document.createElement('div'); 
    col.className='printer-col';
    const slots = document.createElement('div'); 
    slots.className='slots';
    
    // grid rows for hit targets
    for(let i=0;i<48;i++){
      const s = document.createElement('div'); 
      s.className='slot';
      s.dataset.printer = pr.display_name; 
      s.dataset.index = String(i);
      s.addEventListener('click', onSlotClick);
      slots.appendChild(s);
    }
    attachPointerHandlers(slots, pr.display_name);
    col.appendChild(slots);
    printersWrap.appendChild(col);
  });
  
  // Headers and columns are now aligned via CSS table layout
  // No scrolling sync needed
}

function onSlotClick(e){
  // Don't handle clicks on the Reserve button
  if(e.target.closest('.reserve-btn')){
    return;
  }
  // Prevent slot clicks if user was just scrolling (only for touch)
  if(state.isScrolling && e.pointerType === 'touch'){
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  const printer = e.currentTarget.dataset.printer;
  const idx = Number(e.currentTarget.dataset.index);
  const startMin = idx*30; const endMin = startMin+60; // Default to 1 hour
  state.selection = { printer, startMin, endMin };
  renderReservations();
  // Don't auto-open dialog - user must click Reserve button
}

function clearSelection(){
  state.selection = null;
  renderReservations();
}

function renderReservations(){
  // Remove existing blocks
  document.querySelectorAll('.block').forEach(el => el.remove());
  document.querySelectorAll('.selection').forEach(el => el.remove());
  document.querySelectorAll('.current-time').forEach(el => el.remove());

  const today = getCurrentDateInChicago();
  const isToday = state.date === today;
  let currentTimePos = null;
  if(isToday){
    // Get current time in Chicago timezone
    const now = new Date();
    const chicagoTime = new Intl.DateTimeFormat('en-US', {
      timeZone: CONFIG.TIMEZONE,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).formatToParts(now);
    
    const hour = parseInt(chicagoTime.find(p => p.type === 'hour').value);
    const minute = parseInt(chicagoTime.find(p => p.type === 'minute').value);
    const currentMin = hour * 60 + minute;
    
    const firstCol = printersWrap.children[0];
    if(firstCol){
      const slots = firstCol.querySelector('.slots');
      if(slots){
        const rowHeight = slots.querySelector('.slot')?.getBoundingClientRect().height || 28;
        currentTimePos = (currentMin / 30) * rowHeight;
      }
    }
  }
  
  // Get row height from time column for alignment
  const timeSlots = timeCol.querySelector('.time-col-slots');
  const timeRowHeight = timeSlots?.querySelector('.time')?.getBoundingClientRect().height || 28;

  // For each printer column, overlay blocks
  const operationalPrinters = state.printers.filter(p => p.status === 'operational');
  operationalPrinters.forEach((pr, colIdx) => {
    const col = printersWrap.children[colIdx]; if(!col) return;
    const slots = col.querySelector('.slots');
    const rowHeight = slots.querySelector('.slot')?.getBoundingClientRect().height || 28;
    const blocks = state.reservations.filter(r => r.printer===pr.display_name);
    blocks.forEach(r => {
      const top = (minutesSinceMidnight(r.start)/30)*rowHeight;
      const height = ((minutesSinceMidnight(r.end)-minutesSinceMidnight(r.start))/30)*rowHeight;
      const el = document.createElement('div'); el.className='block'; el.style.top = `${top}px`; el.style.height=`${height}px`; el.textContent = 'Reserved';
      slots.appendChild(el);
    });

    if(state.selection && state.selection.printer===pr.display_name){
      const top = (state.selection.startMin/30)*rowHeight;
      const height = ((state.selection.endMin-state.selection.startMin)/30)*rowHeight;
      const sel = document.createElement('div'); sel.className='selection'; sel.style.top = `${top}px`; sel.style.height=`${height}px`;
      const hTop = document.createElement('div'); hTop.className='handle top'; hTop.dataset.printer = pr.display_name;
      const hBot = document.createElement('div'); hBot.className='handle bottom'; hBot.dataset.printer = pr.display_name;
      
      // Attach resize handlers to both handles
      hTop.addEventListener('pointerdown', (ev) => startResize(ev, pr.display_name, 'resize-top', slots));
      hBot.addEventListener('pointerdown', (ev) => startResize(ev, pr.display_name, 'resize-bottom', slots));
      
      sel.appendChild(hTop); sel.appendChild(hBot);
      
      // Add Reserve button inside selection
      const reserveBtn = document.createElement('button');
      reserveBtn.className = 'reserve-btn';
      reserveBtn.textContent = 'Reserve';
      reserveBtn.type = 'button';
      // Stop all pointer events from propagating to underlying slots
      reserveBtn.addEventListener('pointerdown', (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
      });
      reserveBtn.addEventListener('pointerup', (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
      });
      reserveBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
        if(dialog && !dialog.open) openReservationDialog();
      });
      sel.appendChild(reserveBtn);
      
      slots.appendChild(sel);
    }

    // Add current time indicator
    if(isToday && currentTimePos !== null){
      const timeLine = document.createElement('div');
      timeLine.className = 'current-time';
      timeLine.style.top = `${currentTimePos}px`;
      slots.appendChild(timeLine);
    }
  });
}

// Fetch printers from database
async function fetchPrinters() {
  try {
    const { data, error } = await supabase
      .from('printers')
      .select('id, display_name, printer_type, status, notes')
      .eq('is_active', true)
      .eq('status', 'operational') // Only show operational printers
      .order('sort_order', { ascending: true, nullsLast: true })
      .order('display_name', { ascending: true }); // Fallback to display_name if sort_order is null
    
    if (error) throw error;
    
    state.printers = data || [];
    return data || [];
  } catch (err) {
    console.error('Error fetching printers:', err);
    state.printers = [];
    return [];
  }
}

// Fetch reservations for a date
async function fetchReservations(){
  // Clear existing reservations immediately
  state.reservations = [];
  renderReservations();
  
  if (loadingEl) loadingEl.classList.add('active');
  
  try {
    // Convert date to timezone-aware timestamps
    // Parse date as YYYY-MM-DD and create range for Chicago timezone
    const dateStr = state.date;
    
    // Query reservations that overlap with this date
    // A reservation overlaps if: start_at <= endOfDay AND end_at >= startOfDay
    // Use Chicago timezone offset (UTC-6 for standard time)
    const startOfDay = `${dateStr}T00:00:00-06:00`;
    const endOfDay = `${dateStr}T23:59:59-06:00`;
    
    const { data, error } = await supabase
      .from('public_reservations')
      .select('start_at, end_at, printer_display_name')
      .gte('end_at', startOfDay)
      .lte('start_at', endOfDay);
    
    if (error) throw error;
    
    // Transform to frontend format
    state.reservations = (data || []).map(r => {
      const start = new Date(r.start_at);
      const end = new Date(r.end_at);
      
      // Calculate time range for this specific day
      const dayStart = new Date(`${dateStr}T00:00:00`);
      const dayEnd = new Date(`${dateStr}T23:59:59`);
      
      let displayStart = start < dayStart ? dayStart : start;
      let displayEnd = end > dayEnd ? dayEnd : end;
      
      // Format times in Chicago timezone
      const startTime = formatTime(displayStart);
      const endTime = formatTime(displayEnd);
      
      return {
        printer: r.printer_display_name,
        start: startTime,
        end: endTime
      };
    });
    
    renderReservations();
  } catch(err) {
    console.error('Error fetching reservations:', err);
    state.reservations = [];
    renderReservations();
  } finally {
    if (loadingEl) loadingEl.classList.remove('active');
  }
}

function calculateEndTime(){
  if(!resStart.value || !resDuration.value) return;
  const startMin = minutesSinceMidnight(resStart.value);
  const durationHours = parseFloat(resDuration.value) || 1;
  const durationMin = Math.round(durationHours * 60);
  const endMin = startMin + durationMin;
  const days = Math.floor(endMin / (24*60));
  const endClockMin = endMin % (24*60);
  resEndDisplay.value = hhmmFromMinutes(endClockMin);
  const note = document.getElementById('endMultiDayNote');
  if(note){ note.textContent = days > 0 ? `(+${days} day${days>1?'s':''})` : ''; }
}

function toggleOtherInputs(){
  // Show/hide Lab "Other" input
  const wasLabHidden = resLabOther.style.display === 'none' || resLabOther.style.display === '';
  if(resLab.value === 'Other'){
    resLabOther.style.display = 'block';
    resLabOther.required = true;
    // Only clear if it was previously hidden (user just selected "Other")
    if(wasLabHidden) {
      resLabOther.value = '';
    }
  } else {
    resLabOther.style.display = 'none';
    resLabOther.required = false;
    resLabOther.value = '';
  }
  
  // Show/hide Material "Other" input
  const wasMaterialHidden = resMaterialOther.style.display === 'none' || resMaterialOther.style.display === '';
  if(resMaterial.value === 'Other'){
    resMaterialOther.style.display = 'block';
    resMaterialOther.required = true;
    // Only clear if it was previously hidden (user just selected "Other")
    if(wasMaterialHidden) {
      resMaterialOther.value = '';
    }
  } else {
    resMaterialOther.style.display = 'none';
    resMaterialOther.required = false;
    resMaterialOther.value = '';
  }
}

function openReservationDialog(){
  // Seed select options from state.printers
  resPrinter.innerHTML = state.printers
    .filter(p => p.status === 'operational')
    .map(p => `<option>${p.display_name}</option>`)
    .join('');
  resLab.innerHTML = CONFIG.LABS.map(p=>`<option>${p}</option>`).join('');
  resMaterial.innerHTML = CONFIG.MATERIALS.map(p=>`<option>${p}</option>`).join('');

  const sel = state.selection || {
    printer: state.printers[0]?.display_name || '',
    startMin:8*60, 
    endMin:8*60+60
  };
  resPrinter.value = sel.printer;
  resDate.value = state.date;
  resStart.value = hhmmFromMinutes(sel.startMin);
  const durationHours = (sel.endMin - sel.startMin) / 60;
  resDuration.value = durationHours;
  calculateEndTime();
  
  // Reset and toggle "Other" inputs
  resLabOther.value = '';
  resMaterialOther.value = '';
  toggleOtherInputs();
  
  formError.textContent='';
  if(typeof dialog.showModal === 'function') dialog.showModal();
}

// Update end time display when start or duration changes
resStart.addEventListener('input', calculateEndTime);
resDuration.addEventListener('input', calculateEndTime);

// Toggle "Other" text inputs when select values change
resLab.addEventListener('change', toggleOtherInputs);
resMaterial.addEventListener('change', toggleOtherInputs);

function closeDialog(){
  if(dialog.open) dialog.close();
  clearSelection();
}

function validateForm(){
  const start = clampTo30(resStart.value);
  resStart.value = start;
  const durationHours = parseFloat(resDuration.value) || 0;
  if(durationHours < 0.5) return 'Duration must be at least 0.5 hours';
  if(durationHours > 168) return 'Duration cannot exceed 168 hours';
  // Ensure duration is in 0.5 hour increments
  if(durationHours % 0.5 !== 0) return 'Duration must be in 30-minute increments';
  
  const startMin = minutesSinceMidnight(start);
  const durationMin = Math.round(durationHours * 60);
  const endMin = startMin + durationMin;
  const end = hhmmFromMinutes(endMin % (24*60));
  
  if(endMin <= startMin) return 'End must be after start';
  
  // Validate "Other" text inputs
  if(resLab.value === 'Other' && !resLabOther.value.trim()) {
    return 'Please specify the lab/program';
  }
  if(resMaterial.value === 'Other' && !resMaterialOther.value.trim()) {
    return 'Please specify the filament material';
  }
  
  // client-side overlap hint
  const overlap = state.reservations.some(r => r.printer===resPrinter.value && !(minutesSinceMidnight(end) <= minutesSinceMidnight(r.start) || minutesSinceMidnight(start) >= minutesSinceMidnight(r.end)));
  if(overlap) return 'Overlaps an existing reservation';
  return '';
}

// Create reservation
async function createReservation(reservationData) {
  try {
    // Find printer by display_name
    const printer = state.printers.find(p => p.display_name === reservationData.printer);
    if (!printer) {
      throw new Error('Printer not found');
    }
    
    // Parse date and time
    const dateStr = reservationData.date; // YYYY-MM-DD
    const startTime = reservationData.start; // HH:mm
    const endTime = reservationData.end; // HH:mm
    const endDateStr = reservationData.endDate || dateStr; // YYYY-MM-DD
    
    // Create timestamps in Chicago timezone
    // Create Date objects assuming the date/time strings are in Chicago time
    // Then convert to ISO string for PostgreSQL
    const startAt = new Date(`${dateStr}T${startTime}:00`);
    const endAt = new Date(`${endDateStr}T${endTime}:00`);
    
    // Adjust for Chicago timezone offset (UTC-6 for CST, UTC-5 for CDT)
    // For simplicity, we'll use UTC-6 (standard time) and let PostgreSQL handle DST
    // Create a proper ISO string with timezone offset
    const startAtISO = `${dateStr}T${startTime}:00-06:00`;
    const endAtISO = `${endDateStr}T${endTime}:00-06:00`;
    
    // Check for overlaps
    const { data: overlaps, error: checkError } = await supabase
      .rpc('check_reservation_overlap', {
        p_printer_id: printer.id,
        p_start_at: startAtISO,
        p_end_at: endAtISO
      });
    
    if (checkError) throw checkError;
    if (overlaps && overlaps.length > 0) {
      throw new Error('Time overlaps an existing reservation');
    }
    
    // Insert reservation
    const { data, error } = await supabase
      .from('reservations')
      .insert({
        printer_id: printer.id,
        start_at: startAtISO,
        end_at: endAtISO,
        user_name: reservationData.name,
        user_contact: reservationData.contact,
        lab: reservationData.lab,
        material: reservationData.material,
        notes: reservationData.notes,
        status: 'confirmed'
      })
      .select()
      .single();
    
    if (error) throw error;
    return { ok: true, id: data.id };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

form.addEventListener('submit', async (e)=>{
  e.preventDefault();
  const err = validateForm(); if(err){ formError.textContent = err; return; }
  
  // Calculate end time from start + duration
  const start = resStart.value;
  const durationHours = parseFloat(resDuration.value);
  const startMin = minutesSinceMidnight(start);
  const durationMin = Math.round(durationHours * 60);
  const endAbsMin = startMin + durationMin;
  const end = hhmmFromMinutes(endAbsMin % (24*60));
  const addDays = Math.floor(endAbsMin / (24*60));
  const startDateObj = new Date(resDate.value);
  startDateObj.setDate(startDateObj.getDate() + addDays);
  const endDateStr = fmtDateInput(startDateObj);
  
  // Use "Other" text input values if "Other" is selected, otherwise use select value
  const labValue = resLab.value === 'Other' ? resLabOther.value.trim() : resLab.value;
  const materialValue = resMaterial.value === 'Other' ? resMaterialOther.value.trim() : resMaterial.value;
  
  const reservationData = {
    date: resDate.value,
    start: start,
    end: end,
    endDate: endDateStr,
    printer: resPrinter.value,
    name: resName.value,
    contact: resContact.value,
    lab: labValue,
    material: materialValue,
    notes: resNotes.value
  };
  
  const result = await createReservation(reservationData);
  if(!result.ok){ 
    formError.textContent = result.error || 'Reservation rejected.'; 
    return; 
  }
  closeDialog();
  await refresh();
});

document.getElementById('cancelBtn').addEventListener('click', (e)=>{ e.preventDefault(); closeDialog(); clearSelection(); });

async function refresh(){
  await fetchReservations();
}

function scrollToCurrentTime(){
  const today = getCurrentDateInChicago();
  if(state.date !== today) return; // Only scroll if viewing today
  
  // Wait a bit for rendering to complete
  setTimeout(() => {
    const calendarContainer = document.querySelector('.calendar-container');
    const currentTimeLine = document.querySelector('.current-time');
    
    if(calendarContainer && currentTimeLine){
      // Get the position of the current time line
      // The line is positioned relative to its parent slots container
      const slots = currentTimeLine.parentElement;
      if(!slots) return;
      
      // Get the offset of the slots container within the calendar
      const slotsOffsetTop = slots.offsetTop;
      const lineOffsetTop = parseFloat(currentTimeLine.style.top) || 0;
      
      // Total position from top of calendar
      const totalOffset = slotsOffsetTop + lineOffsetTop;
      
      // Calculate scroll position to center the line in the viewport
      const containerHeight = calendarContainer.clientHeight;
      const scrollPosition = totalOffset - (containerHeight / 2);
      
      calendarContainer.scrollTo({
        top: Math.max(0, scrollPosition),
        behavior: 'smooth'
      });
    }
  }, 100);
}

async function init(){
  // Fetch printers first
  await fetchPrinters();
  
  // Populate time column and printers
  buildTimeColumn();
  buildPrinters();
  initControls();
  await refresh();
  updateStickyOffset();
  window.addEventListener('resize', updateStickyOffset);
  
  // Scroll to current time on initial load if viewing today
  // Wait a bit longer to ensure everything is rendered
  setTimeout(() => {
    scrollToCurrentTime();
  }, 200);
  
  // Update current time indicator every minute (only when viewing today)
  setInterval(() => {
    const today = getCurrentDateInChicago();
    if(state.date === today){
      renderReservations();
    }
  }, 60000);
  
  // Clear selection on Escape key
  document.addEventListener('keydown', (e) => {
    if(e.key === 'Escape' && state.selection && !dialog.open){
      clearSelection();
    }
  });
  
  // Clear selection when clicking outside calendar slots
  document.addEventListener('click', (e) => {
    if(state.selection && !dialog.open){
      // Check if click is outside the calendar slots area (but allow header controls)
      const calendar = document.querySelector('.calendar');
      const printers = document.querySelector('.printers');
      const timeCol = document.querySelector('.time-col');
      // Don't clear if clicking on calendar elements, header controls, or Reserve button
      if(calendar && printers && timeCol &&
         !calendar.contains(e.target) && 
         !printers.contains(e.target) &&
         !timeCol.contains(e.target) &&
         !e.target.closest('.reserve-btn') &&
         !e.target.closest('.app-header')){
        clearSelection();
      }
    }
  });
}

// Populate selects at load for accessibility
document.addEventListener('DOMContentLoaded', init);

// Pointer interactions
function updateStickyOffset(){
  const header = document.querySelector('.app-header');
  if(!header) return;
  const h = header.offsetHeight || 56;
  document.documentElement.style.setProperty('--sticky-offset', `${h}px`);
}

function attachPointerHandlers(slotsEl, printer){
  let rect, rowHeight;
  function updateMetrics(){
    rect = slotsEl.getBoundingClientRect();
    const first = slotsEl.querySelector('.slot');
    rowHeight = first ? first.getBoundingClientRect().height : 28;
  }
  function yToMinutes(clientY){
    const y = clientY - rect.top;
    const rows = Math.max(0, Math.min(48, Math.round(y / rowHeight)));
    return rows * 30;
  }
  function onPointerDown(ev){
    if(ev.button !== 0 && ev.pointerType !== 'touch') return;
    // Don't handle pointer events on the Reserve button
    if(ev.target.closest('.reserve-btn')){
      return;
    }
    // Don't handle if clicking on resize handles - they have their own handlers
    if(ev.target.closest('.handle')){
      return;
    }
    // Don't overwrite an existing resize operation
    if(state.drag && (state.drag.mode === 'resize-top' || state.drag.mode === 'resize-bottom')){
      return;
    }
    updateMetrics();
    slotsEl.setPointerCapture(ev.pointerId);
    const startMin = yToMinutes(ev.clientY);
    const endMin = Math.min(startMin + 60, 24*60);
    // Store initial pointer position to track movement distance
    state.drag = { 
      mode:'creating', 
      printer, 
      startMin, 
      endMin,
      startX: ev.clientX,
      startY: ev.clientY
    };
    // Reset scrolling flag
    state.isScrolling = false;
    
    // For mouse clicks (not touch), create selection immediately since it's not a scroll gesture
    if(ev.pointerType === 'mouse'){
      state.selection = { printer, startMin, endMin };
      renderReservations();
      // Stop click event from also firing
      ev.stopPropagation();
    }
    // For touch, wait to see if it's a scroll before creating selection
    ev.preventDefault();
  }
  function onPointerMove(ev){
    if(!state.drag || state.drag.printer!==printer) return;
    updateMetrics();
    const cur = yToMinutes(ev.clientY);
    
    // Handle resize operations - these should never be treated as scrolling
    if(state.drag.mode === 'resize-top' && state.selection){
      const endMin = state.selection.endMin;
      const startMin = Math.min(cur, endMin-30);
      state.selection = { printer, startMin, endMin };
      renderReservations();
      return;
    } else if(state.drag.mode === 'resize-bottom' && state.selection){
      const startMin = state.selection.startMin;
      const endMin = Math.max(cur, startMin+30);
      state.selection = { printer, startMin, endMin };
      renderReservations();
      return;
    }
    
    // Only apply scroll detection for 'creating' mode
    if(state.drag.mode === 'creating'){
      // Calculate movement distance
      const deltaX = Math.abs(ev.clientX - state.drag.startX);
      const deltaY = Math.abs(ev.clientY - state.drag.startY);
      const movementDistance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
      
      // If movement is significant (>10px), treat as scroll and don't create/update selection
      if(movementDistance > 10){
        // Cancel the drag - user is scrolling
        state.isScrolling = true;
        try{ slotsEl.releasePointerCapture(ev.pointerId); }catch(e){}
        state.drag = null;
        state.selection = null;
        renderReservations();
        // Clear scrolling flag after a short delay
        setTimeout(() => { state.isScrolling = false; }, 300);
        return;
      }
      
      // Only create/update selection if movement is minimal (intentional tap/drag)
      const a = Math.min(state.drag.startMin, cur);
      const b = Math.max(state.drag.startMin, cur);
      // Default to 60 minutes (1 hour) if drag distance is small, otherwise use drag distance with 30 min minimum
      const dragDuration = b - a;
      const endMin = dragDuration < 60 ? a + 60 : Math.max(a + 30, b);
      state.selection = { printer, startMin:a, endMin: Math.min(endMin, 24*60) };
      renderReservations();
    }
  }
  function onPointerUp(ev){
    if(!state.drag || state.drag.printer!==printer) return;
    try{ slotsEl.releasePointerCapture(ev.pointerId); }catch(e){}
    
    // Don't apply scroll detection for resize operations - they always involve movement
    if(state.drag.mode === 'resize-top' || state.drag.mode === 'resize-bottom'){
      // Resize operation completed - just clear the drag state, keep the selection
      state.drag = null;
      renderReservations();
      if(ev.pointerType === 'mouse'){
        ev.stopPropagation();
      }
      return;
    }
    
    // Check if this was a scroll (significant movement) - only for 'creating' mode
    const deltaX = Math.abs(ev.clientX - state.drag.startX);
    const deltaY = Math.abs(ev.clientY - state.drag.startY);
    const movementDistance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
    
    if(movementDistance > 10){
      // User was scrolling, clear selection and set flag
      state.isScrolling = true;
      state.selection = null;
      // Clear scrolling flag after a short delay
      setTimeout(() => { state.isScrolling = false; }, 300);
    } else if(movementDistance <= 10 && state.drag.mode === 'creating'){
      // Small movement - this was an intentional tap, create selection if not already created
      // (mouse clicks already have selection created in onPointerDown)
      if(!state.selection){
        const startMin = state.drag.startMin;
        const endMin = state.drag.endMin;
        state.selection = { printer, startMin, endMin };
      }
    }
    // Don't auto-open dialog - user must click Reserve button
    state.drag = null;
    renderReservations();
    
    // For mouse, stop click event from also firing
    if(ev.pointerType === 'mouse'){
      ev.stopPropagation();
    }
  }
  function onPointerCancel(ev){
    // Pointer cancel usually means scroll or gesture, treat as scroll
    if(state.drag && state.drag.printer === printer){
      state.isScrolling = true;
      state.drag = null;
      state.selection = null;
      renderReservations();
      // Clear scrolling flag after a short delay
      setTimeout(() => { state.isScrolling = false; }, 300);
    }
  }
  slotsEl.addEventListener('pointerdown', onPointerDown);
  slotsEl.addEventListener('pointermove', onPointerMove);
  slotsEl.addEventListener('pointerup', onPointerUp);
  slotsEl.addEventListener('pointercancel', onPointerCancel);
}

function startResize(ev, printer, mode, slotsEl){
  ev.stopPropagation();
  ev.preventDefault();
  if(!slotsEl || !state.selection || state.selection.printer !== printer) return;
  
  // Capture pointer on the slots element so we can track movement
  try {
    slotsEl.setPointerCapture(ev.pointerId);
  } catch(e) {
    // Fallback if pointer capture fails
  }
  
  // Set up drag state for resize operation
  // Store initial pointer position to track movement
  const rect = slotsEl.getBoundingClientRect();
  const first = slotsEl.querySelector('.slot');
  const rowHeight = first ? first.getBoundingClientRect().height : 28;
  const y = ev.clientY - rect.top;
  const rows = Math.max(0, Math.min(48, Math.round(y / rowHeight)));
  const curMin = rows * 30;
  
  state.drag = { 
    mode, 
    printer, 
    startMin: state.selection.startMin, 
    endMin: state.selection.endMin,
    startX: ev.clientX,
    startY: ev.clientY
  };
  
  // Trigger initial resize calculation
  if(mode === 'resize-top'){
    const endMin = state.selection.endMin;
    const startMin = Math.min(curMin, endMin-30);
    state.selection = { printer, startMin, endMin };
  } else if(mode === 'resize-bottom'){
    const startMin = state.selection.startMin;
    const endMin = Math.max(curMin, startMin+30);
    state.selection = { printer, startMin, endMin };
  }
  renderReservations();
}
