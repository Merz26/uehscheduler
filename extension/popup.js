import { 
  getSessionToken, 
  getActiveSemesterInfo, 
  getSchedule, 
  verifyPortalAccess, 
  savePortalCredentials, 
  getStoredPortalCredentials,
  portalLogin,
  generateDefaultUehSchedule
} from './portalService.js';

import { 
  authorizeGoogle, 
  logoutGoogle, 
  checkAuth, 
  syncScheduleToGoogleCalendar, 
  cleanCalendarDuplicates,
  PERIOD_TIMES,
  extractCourseCode
} from './calendarService.js';

import { 
  t, 
  setLang, 
  getLang 
} from './i18n.js';

import {
  parseExcel,
  generateICS,
  generateMakeupICS,
  downloadICS,
  convertPortalScheduleToEvents
} from './excelParser.js';

// Global state in popup session
let state = {
  activeView: 'view_schedule',
  scheduleSubView: 'day', // 'day' | 'week'
  googleAccount: null,
  portalToken: null,
  portalProfile: null,
  portalVerification: null,
  semesterInfo: null,
  scheduleData: null,
  selectedWeekIndex: 0,
  theme: 'light',
  lang: 'vi',
  lastSyncTimestamp: null,
  lastSyncInfo: null
};

/**
 * Formats a last sync timestamp with friendly date, time, and relative duration.
 */
function formatLastSyncTimestamp(ts) {
  if (!ts) return null;
  const d = new Date(ts);
  if (isNaN(d.getTime())) return null;

  const pad = (n) => String(n).padStart(2, '0');
  const hours = pad(d.getHours());
  const minutes = pad(d.getMinutes());
  const seconds = pad(d.getSeconds());
  const day = pad(d.getDate());
  const month = pad(d.getMonth() + 1);
  const year = d.getFullYear();

  const now = Date.now();
  const diffSec = Math.max(0, Math.floor((now - d.getTime()) / 1000));

  const isVi = getLang() === 'vi';
  let relative = '';
  if (diffSec < 45) {
    relative = isVi ? '(vừa xong)' : '(just now)';
  } else if (diffSec < 3600) {
    const min = Math.floor(diffSec / 60);
    relative = isVi ? `(${min} phút trước)` : `(${min}m ago)`;
  } else if (diffSec < 86400) {
    const hrs = Math.floor(diffSec / 3600);
    relative = isVi ? `(${hrs} giờ trước)` : `(${hrs}h ago)`;
  } else {
    const days = Math.floor(diffSec / 86400);
    relative = isVi ? `(${days} ngày trước)` : `(${days}d ago)`;
  }

  const timeStr = `${hours}:${minutes}:${seconds} • ${day}/${month}/${year}`;
  return { timeStr, relative, rawDate: d };
}

/**
 * Updates the Visual Status Indicator in the Sync tab:
 * Shows pulsing status dot, formatted timestamp, relative duration, and execution details.
 */
function updateLastSyncIndicator(status = 'idle', timestamp = null, info = null) {
  const dot = document.getElementById('sync_status_dot');
  const pill = document.getElementById('sync_status_pill');
  const timeDisplay = document.getElementById('last_sync_time_display');
  const relativeDisplay = document.getElementById('last_sync_relative_display');
  const metaDisplay = document.getElementById('last_sync_meta_display');

  if (!dot || !pill || !timeDisplay) return;

  const ts = timestamp || state.lastSyncTimestamp;
  const syncInfo = info || state.lastSyncInfo;
  const isVi = getLang() === 'vi';

  if (status === 'syncing') {
    dot.className = 'status-dot status-dot-syncing';
    pill.className = 'badge badge-primary text-xs';
    pill.textContent = isVi ? 'Đang đồng bộ...' : 'Syncing...';
    timeDisplay.textContent = isVi ? 'Đang tiến hành đồng bộ với Google Calendar...' : 'Synchronizing with Google Calendar...';
    if (relativeDisplay) relativeDisplay.textContent = '';
    if (metaDisplay) {
      metaDisplay.style.display = 'block';
      metaDisplay.textContent = isVi ? 'Vui lòng giữ cửa sổ mở trong khi cập nhật lịch' : 'Please keep this window open while updating calendar';
    }
    return;
  }

  if (status === 'error') {
    dot.className = 'status-dot status-dot-warning';
    pill.className = 'badge badge-danger text-xs';
    pill.textContent = isVi ? 'Lỗi đồng bộ' : 'Sync Error';
    timeDisplay.textContent = isVi ? 'Lần đồng bộ gần nhất bị gián đoạn' : 'Last synchronization interrupted';
    if (relativeDisplay) relativeDisplay.textContent = '';
    if (metaDisplay) {
      metaDisplay.style.display = 'block';
      metaDisplay.textContent = isVi ? 'Kiểm tra lại kết nối Google Calendar hoặc Cổng Đào Tạo' : 'Check Google Calendar or Portal connection';
    }
    return;
  }

  // Idle / Completed
  if (ts) {
    const formatted = formatLastSyncTimestamp(ts);
    dot.className = 'status-dot status-dot-success';
    pill.className = 'badge badge-success text-xs';
    pill.textContent = isVi ? 'Đã đồng bộ' : 'Synced';
    
    if (formatted) {
      timeDisplay.textContent = formatted.timeStr;
      if (relativeDisplay) relativeDisplay.textContent = formatted.relative;
    } else {
      timeDisplay.textContent = String(ts);
      if (relativeDisplay) relativeDisplay.textContent = '';
    }

    if (metaDisplay && syncInfo) {
      metaDisplay.style.display = 'block';
      const scopeLabel = syncInfo.scope === 'semester' 
        ? (isVi ? 'Cả học kỳ' : 'Semester') 
        : syncInfo.scope === 'from_this_week' 
          ? (isVi ? 'Từ tuần này' : 'From this week') 
          : (isVi ? 'Tuần này' : 'This week');

      if (syncInfo.insertedCount > 0 || syncInfo.updatedCount > 0) {
        metaDisplay.textContent = isVi 
          ? `✓ Đã thêm ${syncInfo.insertedCount}, cập nhật ${syncInfo.updatedCount} • ${syncInfo.total} tiết học (${scopeLabel})`
          : `✓ Inserted ${syncInfo.insertedCount}, updated ${syncInfo.updatedCount} • ${syncInfo.total} classes (${scopeLabel})`;
      } else {
        metaDisplay.textContent = isVi
          ? `✓ Tất cả ${syncInfo.total} tiết học đã khớp chuẩn • (${scopeLabel})`
          : `✓ All ${syncInfo.total} classes up to date • (${scopeLabel})`;
      }
    }
  } else {
    dot.className = 'status-dot status-dot-idle';
    pill.className = 'badge badge-neutral text-xs';
    pill.textContent = isVi ? 'Chưa đồng bộ' : 'Not Synced';
    timeDisplay.textContent = isVi ? 'Chưa có lịch sử đồng bộ thành công' : 'No successful synchronization recorded yet';
    if (relativeDisplay) relativeDisplay.textContent = '';
    if (metaDisplay) metaDisplay.style.display = 'none';
  }
}

// Full-tab / Full-window detector
function detectWindowMode() {
  const urlParams = new URLSearchParams(window.location.search);
  const isFullParam = urlParams.get('mode') === 'full';
  const isStandAloneWindow = window.self === window.top && window.innerWidth > 450;

  if (isFullParam || isStandAloneWindow) {
    document.documentElement.classList.add('full-window-mode');
    document.body.classList.add('full-window-mode');
    document.documentElement.style.width = '100%';
    document.documentElement.style.height = '100%';
    document.body.style.width = '100%';
    document.body.style.height = '100%';
  }
}

// Initial entry point with document.readyState check (fixes module deferral race condition)
async function initApp() {
  console.log('[UEH Sync] Initializing popup application...');
  detectWindowMode();
  // 1. Immediately bind UI events so tabs and buttons are 100% interactive without waiting for network/storage
  try {
    bindUIEvents();
  } catch (err) {
    console.error('[UEH Sync] Error binding UI events:', err);
  }

  // 2. Load stored preferences & theme
  try {
    await loadStoredPreferences();
  } catch (err) {
    console.warn('[UEH Sync] Stored preferences load warning:', err);
  }

  // 3. Update internationalized labels
  try {
    updateI18nLabels();
  } catch (err) {
    console.warn('[UEH Sync] i18n update warning:', err);
  }

  // 4. Run initial connection check and route guard
  try {
    await runInitialConnectionCheck();
  } catch (err) {
    console.warn('[UEH Sync] Initial connection check warning:', err);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  // DOM is already parsed (common in deferred ES Modules)
  initApp();
}

/**
 * Loads stored theme, language, and background sync preferences.
 */
async function loadStoredPreferences() {
  return new Promise((resolve) => {
    const applyData = (res = {}) => {
      try {
        // Theme
        if (res.appTheme === 'dark') {
          setTheme('dark');
        } else {
          setTheme('light');
        }

        // Language
        if (res.appLang) {
          setLang(res.appLang);
          state.lang = res.appLang;
        }

        // Stored profile & verification
        if (res.studentProfile) state.portalProfile = res.studentProfile;
        if (res.portalVerification) state.portalVerification = res.portalVerification;

        // Restore cached schedule if available so UI renders immediately
        if (res.cachedSchedule && res.cachedSchedule.ds_tuan_tkb) {
          state.scheduleData = res.cachedSchedule;
          if (res.semesterInfo) state.semesterInfo = res.semesterInfo;
          const chip = document.getElementById('active_semester_chip');
          if (chip && state.semesterInfo) {
            chip.textContent = state.semesterInfo.ten_hoc_ky || `HK ${state.semesterInfo.hoc_ky}`;
          }
          renderTodayView();
          populateWeekSelector();
          renderWeekView(state.selectedWeekIndex);
          updateVerificationUI(true);
        }

        // Auto sync UI setup
        const autoSyncToggle = document.getElementById('toggle_auto_sync');
        const autoSyncSection = document.getElementById('auto_sync_config_section');
        const selectFreq = document.getElementById('select_auto_freq');
        const selectDay = document.getElementById('select_auto_day');
        const inputTime = document.getElementById('input_auto_time');
        const groupDay = document.getElementById('group_auto_day');

        if (autoSyncToggle) autoSyncToggle.checked = Boolean(res.autoSyncEnabled);
        if (autoSyncSection) autoSyncSection.style.display = res.autoSyncEnabled ? 'block' : 'none';
        if (selectFreq && res.autoSyncFreq) selectFreq.value = res.autoSyncFreq;
        if (selectDay && res.autoSyncDay) selectDay.value = String(res.autoSyncDay);
        if (inputTime && res.autoSyncTime) inputTime.value = res.autoSyncTime;
        if (groupDay) groupDay.style.display = res.autoSyncFreq === 'weekly' ? 'block' : 'none';

        // App version tag
        const ver = (typeof chrome !== 'undefined' && chrome.runtime?.getManifest?.()?.version) || '1.2.0';
        const verTag = document.getElementById('app_version_tag');
        if (verTag) verTag.textContent = `v${ver}`;

        // Restore last successful sync timestamp and details
        if (res.lastSyncTimestamp) {
          state.lastSyncTimestamp = res.lastSyncTimestamp;
        }
        if (res.lastSyncInfo) {
          state.lastSyncInfo = res.lastSyncInfo;
        }
        updateLastSyncIndicator('idle', state.lastSyncTimestamp, state.lastSyncInfo);
      } catch (err) {
        console.warn('Error applying stored preferences:', err);
      }
      resolve();
    };

    if (typeof chrome !== 'undefined' && chrome.storage?.local?.get) {
      try {
        chrome.storage.local.get([
          'appTheme', 
          'appLang', 
          'autoSyncEnabled', 
          'autoSyncFreq', 
          'autoSyncDay', 
          'autoSyncTime',
          'studentProfile',
          'portalVerification',
          'cachedSchedule',
          'semesterInfo',
          'lastSyncTimestamp',
          'lastSyncInfo'
        ], applyData);
      } catch (e) {
        applyData({});
      }
    } else {
      applyData({});
    }
  });
}

/**
 * Intelligent Route Guards on Launch:
 * Evaluates Google OAuth & UEH Portal tokens.
 * Fallback to Accounts tab if either is disconnected; otherwise default to Schedule.
 */
async function runInitialConnectionCheck() {
  renderConnectionIndicators('pending', 'pending');

  let isGoogleOk = false;
  let isPortalOk = false;

  // 1. Check Google OAuth status
  try {
    const gAuth = await checkAuth();
    if (gAuth && gAuth.token) {
      state.googleAccount = gAuth;
      isGoogleOk = true;
    }
  } catch (e) {
    console.warn('Google check failed:', e);
  }

  // 2. Check UEH Portal status
  try {
    const creds = await getStoredPortalCredentials();
    if (creds && creds.studentId && creds.password) {
      // Pre-fill input
      const idInp = document.getElementById('input_student_id');
      const pwInp = document.getElementById('input_student_password');
      if (idInp) idInp.value = creds.studentId;
      if (pwInp) pwInp.value = creds.password;
    }

    const session = await getSessionToken(false);
    if (session && session.success && session.token) {
      state.portalToken = session.token;
      state.portalProfile = session.profile || state.portalProfile;
      isPortalOk = true;
    }
  } catch (e) {
    console.warn('Portal check failed:', e);
  }

  updateAccountCardsUI(isGoogleOk, isPortalOk);
  renderConnectionIndicators(isPortalOk ? 'ok' : 'err', isGoogleOk ? 'ok' : 'err');

  // Route Guard Logic:
  const routeBanner = document.getElementById('route_guard_banner');
  const accountsBadge = document.getElementById('nav_accounts_badge');

  if (!isGoogleOk || !isPortalOk) {
    // Show warning banner and red badge on Accounts tab
    if (routeBanner) routeBanner.style.display = 'flex';
    if (accountsBadge) accountsBadge.style.display = 'block';

    // Route fallback to Accounts tab
    switchView('view_accounts');
    await loadScheduleData(false);
  } else {
    // Happy path: Route to Schedule tab
    if (routeBanner) routeBanner.style.display = 'none';
    if (accountsBadge) accountsBadge.style.display = 'none';
    switchView('view_schedule');
    await loadScheduleData(false);
  }
}

/**
 * Loads and caches the active semester schedule from Portal REST APIs.
 * Automatically handles cached data, live re-login, and demo fallback.
 */
async function loadScheduleData(forceRefresh = false) {
  const weekSelect = document.getElementById('select_week_dropdown');
  if (weekSelect && (!state.scheduleData || forceRefresh)) {
    weekSelect.innerHTML = `<option value="-1">⏳ ${t('loading_schedule') || 'Đang tải lịch học từ UEH...'}</option>`;
  }

  // 1. Try to restore from cachedSchedule first if not forcing refresh
  if (!forceRefresh && !state.scheduleData) {
    const cached = await new Promise(resolve => {
      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        chrome.storage.local.get(['cachedSchedule', 'semesterInfo'], resolve);
      } else {
        resolve({});
      }
    });

    if (cached.cachedSchedule && cached.cachedSchedule.ds_tuan_tkb) {
      state.scheduleData = cached.cachedSchedule;
      if (cached.semesterInfo) state.semesterInfo = cached.semesterInfo;
      const chip = document.getElementById('active_semester_chip');
      if (chip && state.semesterInfo) {
        chip.textContent = state.semesterInfo.ten_hoc_ky || `HK ${state.semesterInfo.hoc_ky}`;
      }
      renderTodayView();
      populateWeekSelector();
      renderWeekView(state.selectedWeekIndex);
      updateVerificationUI(true);
      return;
    }
  }

  // 2. Fetch fresh from portal API
  try {
    let token = state.portalToken;
    if (!token) {
      const session = await getSessionToken(false);
      if (session && session.success && session.token) {
        state.portalToken = session.token;
        token = session.token;
        state.portalProfile = session.profile || state.portalProfile;
        updateAccountCardsUI(Boolean(state.googleAccount), true);
        renderConnectionIndicators(state.googleAccount ? 'ok' : 'err', 'ok');
      }
    }

    if (token) {
      state.semesterInfo = await getActiveSemesterInfo(token);
      const chip = document.getElementById('active_semester_chip');
      if (chip && state.semesterInfo) {
        chip.textContent = state.semesterInfo.ten_hoc_ky || `HK ${state.semesterInfo.hoc_ky}`;
      }

      state.scheduleData = await getSchedule(token, state.semesterInfo.hoc_ky);
      state.portalVerification = { verified: true, verifiedAt: new Date().toISOString() };

      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        chrome.storage.local.set({
          portalVerification: state.portalVerification,
          cachedSchedule: state.scheduleData,
          semesterInfo: state.semesterInfo
        });
      }

      renderTodayView();
      populateWeekSelector();
      renderWeekView(state.selectedWeekIndex);
      updateVerificationUI(true);
      return;
    }
  } catch (err) {
    console.warn('Error loading schedule data:', err);
    updateVerificationUI(false);
  }

  // 3. Fallback: If no live data and no cache (e.g. preview mode or first run without credentials)
  if (!state.scheduleData || !state.scheduleData.ds_tuan_tkb) {
    state.scheduleData = generateDefaultUehSchedule();
    state.semesterInfo = { hoc_ky: 20261, ten_hoc_ky: 'Học kỳ 1 (2026 - 2027)' };
    const chip = document.getElementById('active_semester_chip');
    if (chip) chip.textContent = state.semesterInfo.ten_hoc_ky;

    renderTodayView();
    populateWeekSelector();
    renderWeekView(state.selectedWeekIndex);
  }
}

/**
 * Renders the Today (Day) View.
 */
function renderTodayView() {
  const container = document.getElementById('today_agenda_container');
  const emptyBox = document.getElementById('empty_today_box');
  const todayDisp = document.getElementById('today_date_display');
  if (!container) return;

  // Format today's date in VN time
  const now = new Date();
  const dayNames = ['Chủ Nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'];
  const dayNamesEn = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const isEn = getLang() === 'en';
  const dayName = isEn ? dayNamesEn[now.getDay()] : dayNames[now.getDay()];
  
  const pad = (n) => String(n).padStart(2, '0');
  const dateFormatted = `${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()}`;
  if (todayDisp) todayDisp.textContent = `${dayName}, ${dateFormatted}`;

  const todayIso = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

  // Find classes scheduled for today
  const todayClasses = [];
  if (state.scheduleData && state.scheduleData.ds_tuan_tkb) {
    state.scheduleData.ds_tuan_tkb.forEach(week => {
      (week.ds_thoi_khoa_bieu || []).forEach(item => {
        const itemDate = (item.ngay_hoc || '').split('T')[0];
        if (itemDate === todayIso) {
          todayClasses.push(item);
        }
      });
    });
  }

  // Sort today's classes by start period
  todayClasses.sort((a, b) => (Number(a.tiet_bat_dau) || 0) - (Number(b.tiet_bat_dau) || 0));

  container.innerHTML = '';
  if (todayClasses.length === 0) {
    if (emptyBox) {
      container.appendChild(emptyBox);
      emptyBox.style.display = 'block';
    }
    return;
  }

  todayClasses.forEach(item => {
    container.appendChild(createClassCard(item));
  });
}

/**
 * Builds a class DOM card element with period pill, room, lecturer, and tags.
 */
function createClassCard(item) {
  const card = document.createElement('div');
  const isMakeup = Boolean(item.is_day_bu || (item.ten_mon || '').includes('Dạy bù') || (item.ghi_chu || '').includes('Dạy bù'));
  card.className = `class-card ${isMakeup ? 'is-makeup' : ''}`;

  const startP = Number(item.tiet_bat_dau) || 1;
  const count = Number(item.so_tiet) || 1;
  const endP = startP + count - 1;

  const startT = PERIOD_TIMES[startP]?.start || '06:45';
  const endT = PERIOD_TIMES[endP]?.end || '09:00';
  const courseCode = item.ma_mon || extractCourseCode(item.ten_mon);

  card.innerHTML = `
    <div class="class-time-row">
      <span class="period-pill">⚡ ${t('period')} ${startP} - ${endP}</span>
      <span class="time-range">${startT} - ${endT}</span>
    </div>
    <div class="class-title">
      ${item.ten_mon || 'Môn học'}
      ${courseCode ? `<span class="text-xs text-muted">(${courseCode})</span>` : ''}
    </div>
    <div class="class-meta-row">
      <span class="meta-pill">📍 ${item.ma_phong ? `Phòng ${item.ma_phong}` : t('room') + ': Chưa xếp'}</span>
      <span class="meta-pill">👨‍🏫 ${item.ten_giang_vien || t('lecturer') + ': Chưa cập nhật'}</span>
      ${isMakeup ? `<span class="tag-makeup">${t('makeup_tag')}</span>` : ''}
    </div>
  `;
  return card;
}

/**
 * Populates the Week Selector Dropdown in Week View.
 */
function parseDate(dateStr) {
  if (!dateStr) return null;
  const clean = String(dateStr).split('T')[0];
  if (clean.includes('/')) {
    const parts = clean.split('/').map(Number);
    if (parts.length === 3) {
      return new Date(parts[2], parts[1] - 1, parts[0], 0, 0, 0, 0);
    }
  } else if (clean.includes('-')) {
    const parts = clean.split('-').map(Number);
    if (parts.length === 3) {
      return new Date(parts[0], parts[1] - 1, parts[2], 0, 0, 0, 0);
    }
  }
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? null : d;
}

function formatDateShort(dateStr) {
  if (!dateStr) return '';
  const clean = String(dateStr).split('T')[0];
  if (clean.includes('/')) {
    const parts = clean.split('/');
    if (parts.length === 3) return `${parts[0]}/${parts[1]}/${parts[2]}`;
  } else if (clean.includes('-')) {
    const parts = clean.split('-');
    if (parts.length === 3) return `${parts[2]}/${parts[1]}/${parts[0]}`;
  }
  return dateStr;
}

/**
 * Populates the Week Selector Dropdown in Week View and defaults to the current week.
 */
function populateWeekSelector() {
  const select = document.getElementById('select_week_dropdown');
  if (!select || !state.scheduleData || !state.scheduleData.ds_tuan_tkb) return;

  select.innerHTML = '';
  const weeks = state.scheduleData.ds_tuan_tkb;
  const now = new Date();
  now.setHours(0, 0, 0, 0);

  let defaultIdx = 0;
  let minDiff = Infinity;

  weeks.forEach((week, idx) => {
    const rawStart = week.ngay_bat_dau || week.ngay_bd || week.tu_ngay || '';
    const rawEnd = week.ngay_ket_thuc || week.ngay_kt || week.den_ngay || '';
    const startStr = String(rawStart).split('T')[0];
    const endStr = String(rawEnd).split('T')[0];
    
    const s = parseDate(startStr);
    const e = parseDate(endStr);

    if (s && e) {
      if (now >= s && now <= e) {
        defaultIdx = idx;
      } else {
        const diff = Math.min(Math.abs(now.getTime() - s.getTime()), Math.abs(now.getTime() - e.getTime()));
        if (diff < minDiff && now >= s) {
          minDiff = diff;
          defaultIdx = idx;
        }
      }
    }

    const opt = document.createElement('option');
    opt.value = idx;
    opt.textContent = `${week.ten_tuan || `Tuần ${idx + 1}`} [${formatDateShort(startStr)} - ${formatDateShort(endStr)}]`;
    select.appendChild(opt);
  });

  state.selectedWeekIndex = defaultIdx;
  select.value = defaultIdx;
  updateWeekSubtitle(defaultIdx);
}

function updateWeekSubtitle(idx) {
  const subtitle = document.getElementById('week_range_subtitle');
  if (!subtitle || !state.scheduleData?.ds_tuan_tkb?.[idx]) return;
  const w = state.scheduleData.ds_tuan_tkb[idx];
  const startStr = (w.ngay_bat_dau || w.ngay_bd || w.tu_ngay || '').split('T')[0];
  const endStr = (w.ngay_ket_thuc || w.ngay_kt || w.den_ngay || '').split('T')[0];
  subtitle.textContent = `${formatDateShort(startStr)} - ${formatDateShort(endStr)}`;
}

/**
 * Renders Vertical Expandable Day Cards for the selected week.
 */
function renderWeekView(weekIndex) {
  const container = document.getElementById('week_days_vertical_container');
  if (!container) return;
  
  if (!state.scheduleData?.ds_tuan_tkb?.[weekIndex]) {
    container.innerHTML = `<div class="card text-xs text-muted" style="padding:12px; text-align:center;">${t('no_classes_in_week')}</div>`;
    return;
  }

  container.innerHTML = '';
  const week = state.scheduleData.ds_tuan_tkb[weekIndex];
  const classes = week.ds_thoi_khoa_bieu || week.ds_tkb || week.tkb || [];

  // Group classes by day of week
  const dayNames = ['Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7', 'Chủ Nhật'];
  const dayNamesEn = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const isEn = getLang() === 'en';

  // Build 7 calendar days starting from week's ngay_bat_dau in local date
  const startDateStr = (week.ngay_bat_dau || week.ngay_bd || week.tu_ngay || '').split('T')[0];
  let startDate = parseDate(startDateStr) || new Date();

  for (let i = 0; i < 7; i++) {
    const curDate = new Date(startDate);
    curDate.setDate(startDate.getDate() + i);
    const pad = (n) => String(n).padStart(2, '0');
    const dateStr = `${curDate.getFullYear()}-${pad(curDate.getMonth() + 1)}-${pad(curDate.getDate())}`;
    const dateDisplay = `${pad(curDate.getDate())}/${pad(curDate.getMonth() + 1)}`;

    const dayClasses = classes.filter(c => (c.ngay_hoc || '').split('T')[0] === dateStr);
    dayClasses.sort((a, b) => (Number(a.tiet_bat_dau) || 0) - (Number(b.tiet_bat_dau) || 0));

    const dayName = isEn ? dayNamesEn[i] : dayNames[i];

    const accordion = document.createElement('div');
    accordion.className = 'day-accordion';

    const hasClasses = dayClasses.length > 0;
    const badgeClass = hasClasses ? 'badge-primary' : 'badge-neutral';

    accordion.innerHTML = `
      <div class="day-accordion-header" data-day="${i}">
        <span>${dayName} • <span class="text-muted font-medium">${dateDisplay}</span></span>
        <span class="badge ${badgeClass}">${dayClasses.length} ${t('classes_count')}</span>
      </div>
      <div class="day-accordion-body" id="day_body_${i}" style="display: ${hasClasses ? 'flex' : 'none'};">
        ${hasClasses ? '' : `<div class="text-xs text-muted" style="padding:6px;">${t('no_classes_in_week')}</div>`}
      </div>
    `;

    const body = accordion.querySelector(`#day_body_${i}`);
    if (hasClasses) {
      dayClasses.forEach(c => body.appendChild(createClassCard(c)));
    }

    // Toggle on header click
    accordion.querySelector('.day-accordion-header').onclick = () => {
      const isVisible = body.style.display === 'flex';
      body.style.display = isVisible ? 'none' : 'flex';
    };

    container.appendChild(accordion);
  }
}

/**
 * Handles Tab Navigation Switching.
 */
function switchView(viewId) {
  state.activeView = viewId;

  // Toggle active tab buttons
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === viewId);
  });

  // Toggle tab view containers
  document.querySelectorAll('.tab-view').forEach(view => {
    view.classList.toggle('active', view.id === viewId);
  });

  if (viewId === 'view_schedule' && !state.scheduleData) {
    loadScheduleData(false);
  }

  if (viewId === 'view_sync') {
    updateLastSyncIndicator('idle', state.lastSyncTimestamp, state.lastSyncInfo);
  }
}

/**
 * Updates UI labels when changing language.
 */
function updateI18nLabels() {
  const current = getLang();
  state.lang = current;

  // Refresh last sync indicator with the active language
  updateLastSyncIndicator('idle', state.lastSyncTimestamp, state.lastSyncInfo);

  // Update all marked ui_ elements
  document.querySelectorAll('[id^="ui_"]').forEach(el => {
    const key = el.id.replace('ui_', '');
    const val = t(key);
    if (val && val !== key) {
      el.textContent = val;
    }
  });

  // Nav labels
  const navSched = document.getElementById('nav_label_schedule');
  const navSync = document.getElementById('nav_label_sync');
  const navAcc = document.getElementById('nav_label_accounts');
  const navSet = document.getElementById('nav_label_settings');

  if (navSched) navSched.textContent = t('tab_schedule');
  if (navSync) navSync.textContent = t('tab_sync');
  if (navAcc) navAcc.textContent = t('tab_accounts');
  if (navSet) navSet.textContent = t('tab_settings');

  // Top header language indicator
  const langIndicator = document.getElementById('lang_indicator');
  if (langIndicator) {
    langIndicator.textContent = current === 'vi' ? 'VN' : 'EN';
  }
  const flag = document.getElementById('lang_flag');
  if (flag) {
    flag.textContent = current === 'vi' ? '🇻🇳' : '🇬🇧';
  }

  // Settings toggle buttons (VN / EN)
  const btnLangVi = document.getElementById('btn_lang_vi');
  const btnLangEn = document.getElementById('btn_lang_en');
  if (btnLangVi) btnLangVi.classList.toggle('active', current === 'vi');
  if (btnLangEn) btnLangEn.classList.toggle('active', current === 'en');

  // Sync Scope dropdown options
  const optThisWeek = document.getElementById('opt_scope_this_week');
  const optFromThisWeek = document.getElementById('opt_scope_from_this_week');
  const optSemester = document.getElementById('opt_scope_semester');
  if (optThisWeek) optThisWeek.textContent = t('sync_scope_this_week');
  if (optFromThisWeek) optFromThisWeek.textContent = t('sync_scope_from_this_week');
  if (optSemester) optSemester.textContent = t('sync_scope_semester');

  // Auto-sync options
  const optFreqDaily = document.getElementById('opt_freq_daily');
  const optFreqWeekly = document.getElementById('opt_freq_weekly');
  if (optFreqDaily) optFreqDaily.textContent = t('freq_daily');
  if (optFreqWeekly) optFreqWeekly.textContent = t('freq_weekly');

  // Days in auto sync selector
  const selectAutoDay = document.getElementById('select_auto_day');
  if (selectAutoDay) {
    const dayNames = current === 'en'
      ? ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
      : ['Chủ Nhật', 'Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7'];
    for (const opt of selectAutoDay.options) {
      const dayVal = Number(opt.value);
      if (dayNames[dayVal]) opt.textContent = dayNames[dayVal];
    }
  }

  // Buttons & inputs
  const btnConnectGoogle = document.getElementById('btn_connect_google');
  const btnSwitchGoogle = document.getElementById('btn_switch_google');
  const btnDisconnectGoogle = document.getElementById('btn_disconnect_google');
  if (btnConnectGoogle) btnConnectGoogle.textContent = t('connect_google');
  if (btnSwitchGoogle) btnSwitchGoogle.textContent = t('switch_account');
  if (btnDisconnectGoogle) btnDisconnectGoogle.textContent = t('disconnect');

  const btnToggleMask = document.getElementById('btn_toggle_password_mask');
  const inputPw = document.getElementById('input_student_password');
  if (btnToggleMask && inputPw) {
    const isPw = inputPw.type === 'password';
    btnToggleMask.textContent = isPw ? t('show_password') : t('hide_password');
  }

  const btnToggleCreds = document.getElementById('btn_toggle_creds_form');
  if (btnToggleCreds) {
    const credsForm = document.getElementById('creds_form_wrap');
    const isShown = credsForm && credsForm.style.display !== 'none';
    btnToggleCreds.textContent = isShown ? (current === 'vi' ? 'Ẩn' : 'Hide') : t('edit_creds');
  }

  const btnRefreshToday = document.getElementById('btn_refresh_today');
  if (btnRefreshToday) btnRefreshToday.textContent = t('refresh_today');

  const btnThemeLight = document.getElementById('btn_theme_light');
  const btnThemeDark = document.getElementById('btn_theme_dark');
  if (btnThemeLight) btnThemeLight.textContent = t('theme_light');
  if (btnThemeDark) btnThemeDark.textContent = t('theme_dark');

  const inputStudentId = document.getElementById('input_student_id');
  if (inputStudentId) inputStudentId.placeholder = t('student_id_placeholder');
  if (inputPw) inputPw.placeholder = t('password_placeholder');

  // Active Semester Chip
  const semChip = document.getElementById('active_semester_chip');
  if (semChip) {
    const semCode = state.semesterInfo?.ma_hoc_ky || '20261';
    semChip.textContent = current === 'en' ? `Sem ${semCode}` : `HK ${semCode}`;
  }

  // Update account cards and badges
  updateAccountCardsUI(Boolean(state.googleAccount), Boolean(state.portalProfile));
  if (state.portalVerification !== null) {
    updateVerificationUI(state.portalVerification);
  }

  // Refresh schedule text
  renderTodayView();
  if (state.scheduleData) {
    renderWeekView(state.selectedWeekIndex);
  }
}

/**
 * Sets Light or Dark theme.
 */
function setTheme(theme) {
  state.theme = theme;
  document.body.className = `theme-${theme}`;
  chrome.storage.local.set({ appTheme: theme });

  const icon = document.getElementById('theme_icon');
  if (icon) icon.textContent = theme === 'dark' ? '☀️' : '🌓';

  const btnLight = document.getElementById('btn_theme_light');
  const btnDark = document.getElementById('btn_theme_dark');
  if (btnLight) btnLight.classList.toggle('active', theme === 'light');
  if (btnDark) btnDark.classList.toggle('active', theme === 'dark');
}

/**
 * Binds all user interactions and listeners.
 */
function bindUIEvents() {
  // Bottom Nav
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.onclick = () => switchView(btn.dataset.view);
  });

  // Theme & Lang Quick Buttons & Expand Full Window Button
  const btnOpenTab = document.getElementById('btn_open_tab');
  if (btnOpenTab) {
    btnOpenTab.onclick = () => {
      const isFull = document.body.classList.contains('full-window-mode');
      if (isFull) {
        document.documentElement.classList.remove('full-window-mode');
        document.body.classList.remove('full-window-mode');
        document.documentElement.style.width = '390px';
        document.documentElement.style.height = '590px';
        document.body.style.width = '390px';
        document.body.style.height = '590px';
      } else {
        if (typeof chrome !== 'undefined' && chrome.tabs && typeof chrome.tabs.create === 'function') {
          chrome.tabs.create({ url: chrome.runtime.getURL('extension/popup.html?mode=full') });
        } else {
          window.open('extension/popup.html?mode=full', '_blank');
        }
      }
    };
  }

  const btnLang = document.getElementById('btn_toggle_lang');
  if (btnLang) {
    btnLang.onclick = () => {
      const nextLang = getLang() === 'vi' ? 'en' : 'vi';
      setLang(nextLang);
      updateI18nLabels();
    };
  }

  const btnTheme = document.getElementById('btn_toggle_theme');
  if (btnTheme) {
    btnTheme.onclick = () => {
      setTheme(state.theme === 'dark' ? 'light' : 'dark');
    };
  }

  // Segmented Control (Day vs Week)
  const btnDay = document.getElementById('btn_view_day');
  const btnWeek = document.getElementById('btn_view_week');
  const subDay = document.getElementById('subview_day');
  const subWeek = document.getElementById('subview_week');

  if (btnDay && btnWeek) {
    btnDay.onclick = () => {
      btnDay.classList.add('active');
      btnWeek.classList.remove('active');
      if (subDay) subDay.style.display = 'block';
      if (subWeek) subWeek.style.display = 'none';
      state.scheduleSubView = 'day';
    };

    btnWeek.onclick = async () => {
      btnWeek.classList.add('active');
      btnDay.classList.remove('active');
      if (subDay) subDay.style.display = 'none';
      if (subWeek) subWeek.style.display = 'block';
      state.scheduleSubView = 'week';
      if (!state.scheduleData) {
        await loadScheduleData(false);
      } else {
        populateWeekSelector();
        renderWeekView(state.selectedWeekIndex);
      }
    };
  }

  // Refresh Today button
  const btnRefreshToday = document.getElementById('btn_refresh_today');
  if (btnRefreshToday) {
    btnRefreshToday.onclick = async () => {
      btnRefreshToday.textContent = 'Đang tải...';
      await loadScheduleData(true);
      btnRefreshToday.textContent = t('refresh_today') || '🔄 Làm mới';
    };
  }

  // Refresh Week button
  const btnRefreshWeek = document.getElementById('btn_refresh_week');
  if (btnRefreshWeek) {
    btnRefreshWeek.onclick = async () => {
      const origHtml = btnRefreshWeek.innerHTML;
      btnRefreshWeek.textContent = 'Đang tải...';
      await loadScheduleData(true);
      btnRefreshWeek.innerHTML = origHtml;
    };
  }

  // Week Selector Dropdown
  const weekSelect = document.getElementById('select_week_dropdown');
  if (weekSelect) {
    weekSelect.onchange = async (e) => {
      const idx = parseInt(e.target.value, 10);
      if (isNaN(idx) || idx < 0) return;
      state.selectedWeekIndex = idx;
      if (!state.scheduleData) {
        await loadScheduleData(false);
      }
      updateWeekSubtitle(idx);
      renderWeekView(idx);
    };
  }

  // Expand / Collapse all days
  const btnExpandAll = document.getElementById('btn_expand_all_days');
  const btnCollapseAll = document.getElementById('btn_collapse_all_days');
  if (btnExpandAll) {
    btnExpandAll.onclick = () => {
      document.querySelectorAll('.day-accordion-body').forEach(b => b.style.display = 'flex');
    };
  }
  if (btnCollapseAll) {
    btnCollapseAll.onclick = () => {
      document.querySelectorAll('.day-accordion-body').forEach(b => b.style.display = 'none');
    };
  }

  // Start Sync Action
  const btnStartSync = document.getElementById('btn_start_sync_action');
  if (btnStartSync) {
    btnStartSync.onclick = handleStartSync;
  }

  // Deduplication Cleaner Action (Fixes image.png duplicates!)
  const btnCleanDuplicates = document.getElementById('btn_clean_duplicates_action');
  if (btnCleanDuplicates) {
    btnCleanDuplicates.onclick = handleCleanDuplicates;
  }

  // Auto-sync controls
  const toggleAutoSync = document.getElementById('toggle_auto_sync');
  const autoSyncSection = document.getElementById('auto_sync_config_section');
  const selectAutoFreq = document.getElementById('select_auto_freq');
  const groupAutoDay = document.getElementById('group_auto_day');
  const btnSaveAutoSync = document.getElementById('btn_save_auto_sync');

  if (toggleAutoSync) {
    toggleAutoSync.onchange = () => {
      if (autoSyncSection) autoSyncSection.style.display = toggleAutoSync.checked ? 'block' : 'none';
    };
  }

  if (selectAutoFreq) {
    selectAutoFreq.onchange = () => {
      if (groupAutoDay) groupAutoDay.style.display = selectAutoFreq.value === 'weekly' ? 'block' : 'none';
    };
  }

  if (btnSaveAutoSync) {
    btnSaveAutoSync.onclick = handleSaveAutoSync;
  }

  // Google Account Connect / Switch / Disconnect
  const btnConnectGoogle = document.getElementById('btn_connect_google');
  const btnSwitchGoogle = document.getElementById('btn_switch_google');
  const btnDisconnectGoogle = document.getElementById('btn_disconnect_google');

  if (btnConnectGoogle) {
    btnConnectGoogle.onclick = async () => {
      try {
        btnConnectGoogle.textContent = 'Connecting...';
        const acc = await authorizeGoogle();
        state.googleAccount = acc;
        updateAccountCardsUI(true, Boolean(state.portalToken));
        renderConnectionIndicators(state.portalToken ? 'ok' : 'err', 'ok');
      } catch (err) {
        alert(err.message || 'Google authorization failed');
      } finally {
        btnConnectGoogle.textContent = t('connect_google');
      }
    };
  }

  if (btnSwitchGoogle) {
    btnSwitchGoogle.onclick = async () => {
      await logoutGoogle();
      const acc = await authorizeGoogle();
      state.googleAccount = acc;
      updateAccountCardsUI(true, Boolean(state.portalToken));
    };
  }

  if (btnDisconnectGoogle) {
    btnDisconnectGoogle.onclick = async () => {
      await logoutGoogle();
      state.googleAccount = null;
      updateAccountCardsUI(false, Boolean(state.portalToken));
      renderConnectionIndicators(state.portalToken ? 'ok' : 'err', 'err');
    };
  }

  // Portal Credentials Drawer & Password Mask Toggle
  const btnToggleCreds = document.getElementById('btn_toggle_creds_form');
  const credsWrap = document.getElementById('creds_form_wrap');
  if (btnToggleCreds && credsWrap) {
    btnToggleCreds.onclick = () => {
      const isHidden = credsWrap.style.display === 'none';
      credsWrap.style.display = isHidden ? 'flex' : 'none';
      btnToggleCreds.textContent = isHidden ? 'Thu gọn' : 'Chỉnh sửa';
    };
  }

  const btnToggleMask = document.getElementById('btn_toggle_password_mask');
  const inputPw = document.getElementById('input_student_password');
  if (btnToggleMask && inputPw) {
    btnToggleMask.onclick = () => {
      const isPw = inputPw.type === 'password';
      inputPw.type = isPw ? 'text' : 'password';
      btnToggleMask.textContent = isPw ? t('hide_password') : t('show_password');
    };
  }

  // Save Portal Credentials
  const btnSaveCreds = document.getElementById('btn_save_portal_creds');
  if (btnSaveCreds) {
    btnSaveCreds.onclick = handleSavePortalCreds;
  }

  // Diagnostics Pings
  const btnDiagSem = document.getElementById('btn_diag_sem');
  const btnDiagWeek = document.getElementById('btn_diag_week');
  if (btnDiagSem) btnDiagSem.onclick = () => handleDiagPing('sem');
  if (btnDiagWeek) btnDiagWeek.onclick = () => handleDiagPing('week');

  // Settings Theme & Lang Buttons
  const btnThemeLight = document.getElementById('btn_theme_light');
  const btnThemeDark = document.getElementById('btn_theme_dark');
  if (btnThemeLight) btnThemeLight.onclick = () => setTheme('light');
  if (btnThemeDark) btnThemeDark.onclick = () => setTheme('dark');

  const btnLangVi = document.getElementById('btn_lang_vi');
  const btnLangEn = document.getElementById('btn_lang_en');
  if (btnLangVi) {
    btnLangVi.onclick = () => {
      setLang('vi');
      updateI18nLabels();
      btnLangVi.classList.add('active');
      btnLangEn.classList.remove('active');
    };
  }
  if (btnLangEn) {
    btnLangEn.onclick = () => {
      setLang('en');
      updateI18nLabels();
      btnLangEn.classList.add('active');
      btnLangVi.classList.remove('active');
    };
  }

  // Offline ICS Export & Excel Drop Zone
  const btnExpSem = document.getElementById('btn_export_semester_ics');
  const btnExpMakeup = document.getElementById('btn_export_makeup_ics');
  const dropZone = document.getElementById('excel_drop_zone');
  const fileInput = document.getElementById('file_excel_input');

  if (btnExpSem) btnExpSem.onclick = handleExportSemesterICS;
  if (btnExpMakeup) btnExpMakeup.onclick = handleExportMakeupICS;

  if (dropZone && fileInput) {
    dropZone.onclick = () => fileInput.click();
    dropZone.ondragover = (e) => { e.preventDefault(); dropZone.style.borderColor = 'var(--primary)'; };
    dropZone.ondragleave = () => { dropZone.style.borderColor = 'var(--border-subtle)'; };
    dropZone.ondrop = async (e) => {
      e.preventDefault();
      dropZone.style.borderColor = 'var(--border-subtle)';
      if (e.dataTransfer.files.length > 0) {
        await handleExcelFile(e.dataTransfer.files[0]);
      }
    };
    fileInput.onchange = async () => {
      if (fileInput.files.length > 0) {
        await handleExcelFile(fileInput.files[0]);
      }
    };
  }

  // External Wiki, TOS & Privacy Links
  document.querySelectorAll('.about-link-row').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const url = link.getAttribute('href') || 'https://github.com/Merz26/ftuschedule/wiki';
      if (typeof chrome !== 'undefined' && chrome.tabs && typeof chrome.tabs.create === 'function') {
        chrome.tabs.create({ url });
      } else {
        window.open(url, '_blank', 'noopener,noreferrer');
      }
    });
  });
}

/**
 * Handles Start Synchronization with Pre-Insert Deduplication.
 */
async function handleStartSync() {
  if (!state.googleAccount?.token) {
    alert('Vui lòng kết nối tài khoản Google trước khi đồng bộ!');
    switchView('view_accounts');
    return;
  }

  if (!state.scheduleData || !state.scheduleData.ds_tuan_tkb) {
    alert('Không tìm thấy dữ liệu thời khóa biểu để đồng bộ. Vui lòng kiểm tra kết nối Cổng Đào Tạo!');
    switchView('view_accounts');
    return;
  }

  const scopeSelect = document.getElementById('select_sync_scope');
  const scope = scopeSelect ? scopeSelect.value : 'this_week';
  const checkResync = document.getElementById('check_resync_deleted');
  const reinsertDeleted = checkResync ? checkResync.checked : true;

  const statusBox = document.getElementById('sync_status_box');
  const progressBar = document.getElementById('sync_progress_bar');
  const progressBarWrap = document.getElementById('sync_progress_bar_wrap');
  const percentLabel = document.getElementById('sync_progress_percent');
  const statusHeader = document.getElementById('sync_status_header');
  const stepDetail = document.getElementById('sync_progress_step_detail');
  const counterLabel = document.getElementById('sync_progress_counter');
  const spinnerIcon = document.getElementById('sync_spinner_icon');
  const logBox = document.getElementById('sync_details_log');
  const btn = document.getElementById('btn_start_sync_action');

  if (statusBox) statusBox.style.display = 'block';
  if (progressBar) {
    progressBar.style.width = '6%';
    progressBar.className = 'sync-progress-bar active';
  }
  if (progressBarWrap) progressBarWrap.setAttribute('aria-valuenow', '6');
  if (percentLabel) percentLabel.textContent = '6%';
  if (spinnerIcon) spinnerIcon.className = 'sync-spinner-icon spinning';
  if (statusHeader) statusHeader.textContent = t('syncing_in_progress');
  if (stepDetail) stepDetail.textContent = t('sync_progress_preparing');
  if (counterLabel) counterLabel.textContent = '0 / --';
  if (logBox) logBox.innerHTML = '';
  if (btn) btn.disabled = true;

  // Set visual status indicator to active syncing
  updateLastSyncIndicator('syncing');

  try {
    const result = await syncScheduleToGoogleCalendar(
      state.googleAccount.token,
      state.scheduleData,
      {
        scope,
        activeWeekIndex: state.selectedWeekIndex,
        reinsertDeleted,
        onProgress: ({ phase, current, total, percent, subject, room, message }) => {
          if (progressBar) {
            progressBar.style.width = `${percent}%`;
            if (progressBarWrap) progressBarWrap.setAttribute('aria-valuenow', String(percent));
          }
          if (percentLabel) percentLabel.textContent = `${percent}%`;
          if (counterLabel && total > 0) counterLabel.textContent = `${current} / ${total}`;
          if (stepDetail) {
            if (message) {
              stepDetail.textContent = message;
            } else if (subject) {
              stepDetail.textContent = `${subject}${room ? ` (${room})` : ''}`;
            }
          }
          if (statusHeader && phase === 'syncing') {
            statusHeader.textContent = `${t('syncing_in_progress')} (${percent}%)`;
          }
        }
      }
    );

    if (progressBar) {
      progressBar.style.width = '100%';
      progressBar.className = 'sync-progress-bar completed';
      if (progressBarWrap) progressBarWrap.setAttribute('aria-valuenow', '100');
    }
    if (percentLabel) percentLabel.textContent = '100%';
    if (spinnerIcon) spinnerIcon.className = 'sync-spinner-icon';
    if (statusHeader) statusHeader.textContent = t('sync_success');
    if (stepDetail) {
      stepDetail.textContent = getLang() === 'vi' 
        ? `✓ Hoàn tất! Đã kiểm tra ${result.total} tiết học.` 
        : `✓ Done! Checked ${result.total} classes.`;
    }
    if (counterLabel && result.total > 0) {
      counterLabel.textContent = `${result.total} / ${result.total}`;
    }

    // Update stats
    const elIns = document.getElementById('stat_inserted');
    const elUpd = document.getElementById('stat_updated');
    const elSkip = document.getElementById('stat_skipped');
    const elClash = document.getElementById('stat_clashes');

    if (elIns) elIns.textContent = result.insertedCount;
    if (elUpd) elUpd.textContent = result.updatedCount;
    if (elSkip) elSkip.textContent = result.skippedCount;
    if (elClash) elClash.textContent = result.clashesCount;

    // Detailed log
    if (logBox) {
      if (result.changes && result.changes.length > 0) {
        logBox.innerHTML = result.changes.slice(0, 10).map(c => `
          <div>• [${c.type.toUpperCase()}] ${c.subject} (${c.room || 'Phòng'}) ${c.reason || ''}</div>
        `).join('');
      } else {
        logBox.innerHTML = `<div>✓ Đã kiểm tra ${result.total} tiết học. Tất cả đã đồng bộ chính xác, không cần chèn trùng lặp.</div>`;
      }
    }

    // Update state and visual status indicator
    state.lastSyncTimestamp = result.timestamp || Date.now();
    state.lastSyncInfo = result.syncInfo || {
      timestamp: state.lastSyncTimestamp,
      insertedCount: result.insertedCount,
      updatedCount: result.updatedCount,
      skippedCount: result.skippedCount,
      clashesCount: result.clashesCount,
      total: result.total,
      scope
    };
    updateLastSyncIndicator('idle', state.lastSyncTimestamp, state.lastSyncInfo);

  } catch (err) {
    if (progressBar) {
      progressBar.className = 'sync-progress-bar';
    }
    if (spinnerIcon) spinnerIcon.className = 'sync-spinner-icon';
    if (statusHeader) statusHeader.textContent = `Lỗi đồng bộ: ${err.message}`;
    if (stepDetail) stepDetail.textContent = 'Quá trình đồng bộ bị gián đoạn.';
    updateLastSyncIndicator('error');
    console.error('Sync error:', err);
  } finally {
    if (btn) btn.disabled = false;
  }
}

/**
 * Handles cleaning existing duplicate calendar events (Directly fixes image.png issue!).
 */
async function handleCleanDuplicates() {
  if (!state.googleAccount?.token) {
    alert('Vui lòng kết nối tài khoản Google trước!');
    return;
  }

  const resultBox = document.getElementById('dedup_result_box');
  const progressBox = document.getElementById('dedup_progress_box');
  const progressBar = document.getElementById('dedup_progress_bar');
  const btn = document.getElementById('btn_clean_duplicates_action');

  if (resultBox) {
    resultBox.style.display = 'block';
    resultBox.textContent = t('dedup_scanning');
  }
  if (progressBox) progressBox.style.display = 'block';
  if (progressBar) {
    progressBar.style.width = '20%';
    progressBar.className = 'sync-progress-bar active';
  }
  if (btn) btn.disabled = true;

  try {
    const res = await cleanCalendarDuplicates(state.googleAccount.token, 'primary', {
      onProgress: ({ percent, message }) => {
        if (progressBar) progressBar.style.width = `${percent}%`;
        if (resultBox && message) resultBox.textContent = message;
      }
    });
    if (progressBar) {
      progressBar.style.width = '100%';
      progressBar.className = 'sync-progress-bar completed';
      setTimeout(() => {
        if (progressBox) progressBox.style.display = 'none';
      }, 1800);
    }
    if (resultBox) {
      resultBox.innerHTML = `✓ ${t('dedup_complete')}<br>Đã quét: <strong>${res.scannedCount}</strong> sự kiện • Đã xóa trùng lặp: <strong class="text-red">${res.removedCount}</strong> sự kiện dư thừa.`;
    }
  } catch (err) {
    if (progressBar) progressBar.className = 'sync-progress-bar';
    if (resultBox) resultBox.textContent = `Lỗi dọn trùng lặp: ${err.message}`;
  } finally {
    if (btn) btn.disabled = false;
  }
}

/**
 * Saves Automated Background Sync preferences.
 */
async function handleSaveAutoSync() {
  const toggle = document.getElementById('toggle_auto_sync');
  const selectFreq = document.getElementById('select_auto_freq');
  const selectDay = document.getElementById('select_auto_day');
  const inputTime = document.getElementById('input_auto_time');
  const statusLabel = document.getElementById('auto_sync_status_label');

  const config = {
    autoSyncEnabled: toggle ? toggle.checked : false,
    autoSyncFreq: selectFreq ? selectFreq.value : 'daily',
    autoSyncDay: selectDay ? Number(selectDay.value) : 1,
    autoSyncTime: inputTime ? inputTime.value : '06:00'
  };

  chrome.storage.local.set(config, () => {
    // Notify background worker to reschedule alarm
    chrome.runtime.sendMessage({ action: 'RESCHEDULE_AUTO_SYNC' }, (res) => {
      if (statusLabel) {
        statusLabel.textContent = `✓ ${t('auto_sync_saved')} (${config.autoSyncTime}, ${config.autoSyncFreq})`;
        setTimeout(() => { statusLabel.textContent = ''; }, 3000);
      }
    });
  });
}

/**
 * Saves Student Portal credentials and tests live login.
 */
async function handleSavePortalCreds() {
  const studentId = document.getElementById('input_student_id')?.value.trim();
  const password = document.getElementById('input_student_password')?.value.trim();
  const btn = document.getElementById('btn_save_portal_creds');

  if (!studentId || !password) {
    alert(t('enter_credentials_msg') || 'Vui lòng nhập Mã sinh viên và Mật khẩu!');
    return;
  }

  if (btn) btn.textContent = 'Đang xác thực...';

  try {
    await savePortalCredentials(studentId, password);
    const loginRes = await portalLogin(studentId, password);
    
    state.portalToken = loginRes.token;
    state.portalProfile = loginRes.profile;

    updateAccountCardsUI(Boolean(state.googleAccount), true);
    renderConnectionIndicators('ok', state.googleAccount ? 'ok' : 'err');

    // Automatically load schedule
    await loadScheduleData();

    // Check if route banner can be hidden
    if (state.googleAccount) {
      const banner = document.getElementById('route_guard_banner');
      const badge = document.getElementById('nav_accounts_badge');
      if (banner) banner.style.display = 'none';
      if (badge) badge.style.display = 'none';
      switchView('view_schedule');
    }

    alert('Xác thực Cổng Đào Tạo UEH thành công!');
  } catch (err) {
    alert(`Xác thực thất bại: ${err.message}`);
  } finally {
    if (btn) btn.textContent = t('btn_save_creds');
  }
}

/**
 * Live Portal Diagnostics Ping for /tkb-hocky or /tkb-tuan.
 */
async function handleDiagPing(type) {
  const out = document.getElementById('diag_result_output');
  const semStatus = document.getElementById('diag_sem_status');
  const weekStatus = document.getElementById('diag_week_status');

  if (out) out.style.display = 'block';

  const t0 = performance.now();
  if (type === 'sem') {
    if (semStatus) semStatus.textContent = '⏳';
    try {
      const session = await getSessionToken(true);
      const sem = await getActiveSemesterInfo(session.token);
      const latency = Math.round(performance.now() - t0);
      if (semStatus) semStatus.textContent = '✓ 200';
      if (out) out.textContent = `[GET /tkb-hocky] OK (${latency}ms)\nHọc kỳ hoạt động: ${sem.ten_hoc_ky || sem.hoc_ky}`;
    } catch (e) {
      if (semStatus) semStatus.textContent = '✗ ERR';
      if (out) out.textContent = `[GET /tkb-hocky] Failed: ${e.message}`;
    }
  } else {
    if (weekStatus) weekStatus.textContent = '⏳';
    try {
      const session = await getSessionToken(true);
      const v = await verifyPortalAccess(session.token);
      const latency = Math.round(performance.now() - t0);
      if (weekStatus) weekStatus.textContent = '✓ 200';
      if (out) out.textContent = `[GET /tkb-tuan] OK (${latency}ms)\nTìm thấy ${v.count} tuần học trực tiếp từ API student.ueh.edu.vn`;
    } catch (e) {
      if (weekStatus) weekStatus.textContent = '✗ ERR';
      if (out) out.textContent = `[GET /tkb-tuan] Failed: ${e.message}`;
    }
  }
}

/**
 * Offline ICS Full Semester Export.
 */
function handleExportSemesterICS() {
  if (!state.scheduleData || !state.scheduleData.ds_tuan_tkb) {
    alert('Chưa có dữ liệu thời khóa biểu để xuất ICS!');
    return;
  }
  const events = convertPortalScheduleToEvents(state.scheduleData);
  const ics = generateICS(events);
  const semName = state.semesterInfo?.hoc_ky || 'semester';
  downloadICS(ics, `UEH_TKB_${semName}.ics`);
}

/**
 * Offline ICS Makeup Classes Export (isolates "Dạy bù").
 */
function handleExportMakeupICS() {
  if (!state.scheduleData || !state.scheduleData.ds_tuan_tkb) {
    alert('Chưa có dữ liệu thời khóa biểu để xuất ICS!');
    return;
  }
  const events = convertPortalScheduleToEvents(state.scheduleData);
  const ics = generateMakeupICS(events);
  downloadICS(ics, 'makeup_classes.ics');
}

/**
 * Parses uploaded Excel schedule file.
 */
async function handleExcelFile(file) {
  try {
    const events = await parseExcel(file);
    const ics = generateICS(events);
    downloadICS(ics, `${file.name.replace(/\.[^/.]+$/, "")}.ics`);
    alert(`Đã đọc thành công ${events.length} môn học từ file Excel và xuất file .ics!`);
  } catch (err) {
    alert(`Lỗi đọc file Excel: ${err.message}`);
  }
}

/**
 * Updates Account card elements based on state.
 */
function updateAccountCardsUI(isGoogleOk, isPortalOk) {
  // Google Card
  const gBadge = document.getElementById('badge_google_status');
  const gEmail = document.getElementById('google_account_email');
  const gName = document.getElementById('google_account_name');
  const btnConnG = document.getElementById('btn_connect_google');
  const btnSwitchG = document.getElementById('btn_switch_google');
  const btnDiscG = document.getElementById('btn_disconnect_google');

  if (isGoogleOk && state.googleAccount) {
    if (gBadge) { gBadge.className = 'badge badge-success'; gBadge.textContent = t('google_authorized'); }
    if (gEmail) gEmail.textContent = state.googleAccount.email || 'Google Account';
    if (gName) gName.textContent = state.googleAccount.name || '';
    if (btnConnG) btnConnG.style.display = 'none';
    if (btnSwitchG) btnSwitchG.style.display = 'inline-block';
    if (btnDiscG) btnDiscG.style.display = 'inline-block';
  } else {
    if (gBadge) { gBadge.className = 'badge badge-amber'; gBadge.textContent = t('google_not_authorized'); }
    if (gEmail) gEmail.textContent = t('disconnected');
    if (gName) gName.textContent = '';
    if (btnConnG) btnConnG.style.display = 'inline-block';
    if (btnSwitchG) btnSwitchG.style.display = 'none';
    if (btnDiscG) btnDiscG.style.display = 'none';
  }

  // Portal Card
  const pBadge = document.getElementById('badge_portal_status');
  const pName = document.getElementById('portal_student_name_display');
  const pSub = document.getElementById('portal_student_subdetails');
  const dId = document.getElementById('disp_student_id');
  const dEmail = document.getElementById('disp_student_email');

  if (isPortalOk && state.portalProfile) {
    if (pBadge) { pBadge.className = 'badge badge-success'; pBadge.textContent = t('portal_verified'); }
    if (pName) pName.textContent = state.portalProfile.name || (getLang() === 'en' ? 'UEH Student' : 'Sinh viên UEH');
    if (pSub) pSub.style.display = 'block';
    if (dId) dId.textContent = state.portalProfile.studentId || '';
    if (dEmail) dEmail.textContent = state.portalProfile.email || '';
  } else {
    if (pBadge) { pBadge.className = 'badge badge-red'; pBadge.textContent = t('portal_expired'); }
    if (pName) pName.textContent = t('portal_not_configured');
    if (pSub) pSub.style.display = 'none';
  }
}

function updateVerificationUI(isVerified) {
  const badge = document.getElementById('badge_tkb_verify');
  const icon = document.getElementById('tkb_icon');
  if (badge) {
    badge.className = isVerified ? 'badge badge-success ml-auto' : 'badge badge-red ml-auto';
    badge.textContent = isVerified ? t('tkb_verified_badge') : t('tkb_unverified_badge');
  }
  if (icon) icon.textContent = isVerified ? '✓' : '✗';
}

function renderConnectionIndicators(portalStatus, googleStatus) {
  const pDot = document.getElementById('header_portal_indicator');
  const gDot = document.getElementById('header_google_indicator');

  if (pDot) {
    pDot.className = `status-dot ${portalStatus === 'ok' ? 'dot-green' : portalStatus === 'err' ? 'dot-red' : 'dot-amber'}`;
  }
  if (gDot) {
    gDot.className = `status-dot ${googleStatus === 'ok' ? 'dot-green' : googleStatus === 'err' ? 'dot-red' : 'dot-amber'}`;
  }
}
