/**
 * FTU Schedule Sync - Data Transformation & Sanitization Module
 * Handles semester formatting, room code normalization, and session mapping.
 */

/**
 * Formats raw semester strings/codes into the standard "Sem/HK [X] [YYYY]" format.
 * Examples:
 *   - "20261" -> "HK 1 2026" (VI) or "Sem 1 2026" (EN)
 *   - "20252" -> "HK 2 2025" (VI) or "Sem 2 2025" (EN)
 *   - "Học kỳ 1 (2026 - 2027)" -> "HK 1 2026" (VI) or "Sem 1 2026" (EN)
 *   - "HK 20261" -> "HK 1 2026" (VI) or "Sem 1 2026" (EN)
 *
 * @param {string|number|object} raw - Raw semester input
 * @param {string} lang - 'vi' or 'en'
 * @returns {string} Formatted string: "HK [X] [YYYY]" or "Sem [X] [YYYY]"
 */
export function formatSemester(raw, lang = 'vi') {
  const isEn = lang === 'en';
  const prefix = isEn ? 'Sem' : 'HK';

  if (!raw) {
    return `${prefix} 1 2026`;
  }

  // Handle object input (e.g. { hoc_ky: 20261, ten_hoc_ky: '...' })
  if (typeof raw === 'object') {
    if (raw.hoc_ky || raw.ma_hoc_ky) {
      return formatSemester(raw.hoc_ky || raw.ma_hoc_ky, lang);
    }
    if (raw.ten_hoc_ky) {
      return formatSemester(raw.ten_hoc_ky, lang);
    }
  }

  const str = String(raw).trim();

  // Pattern 1: Pure 5 digits e.g. "20261", "20252", "20253" (Year: 2026, Semester: 1)
  const codeMatch = str.match(/^(\d{4})([1-9])$/);
  if (codeMatch) {
    const year = codeMatch[1];
    const sem = codeMatch[2];
    return `${prefix} ${sem} ${year}`;
  }

  // Pattern 2: "HK 20261" or "Sem 20261"
  const prefixCodeMatch = str.match(/(?:HK|Sem|Học\s*kỳ|Semester)\s*(\d{4})([1-9])/i);
  if (prefixCodeMatch) {
    const year = prefixCodeMatch[1];
    const sem = prefixCodeMatch[2];
    return `${prefix} ${sem} ${year}`;
  }

  // Pattern 3: Text like "Học kỳ 1 (2026 - 2027)" or "Semester 2 2025-2026"
  const textMatch = str.match(/(?:Học\s*kỳ|Semester|Sem|HK)\s*(\d+)[^\d]+?(\d{4})/i);
  if (textMatch) {
    const sem = textMatch[1];
    const year = textMatch[2];
    return `${prefix} ${sem} ${year}`;
  }

  // Pattern 4: Fallback 5 digits anywhere in the string
  const fiveDigitMatch = str.match(/(\d{4})([1-9])/);
  if (fiveDigitMatch) {
    const year = fiveDigitMatch[1];
    const sem = fiveDigitMatch[2];
    return `${prefix} ${sem} ${year}`;
  }

  // Pattern 5: Look for any single digit for sem and 4 digits for year
  const anySem = str.match(/(?:HK|Sem|kỳ)?\s*(\d)\b/i);
  const anyYear = str.match(/\b(20\d{2})\b/);
  if (anySem && anyYear) {
    return `${prefix} ${anySem[1]} ${anyYear[1]}`;
  }

  return `${prefix} 1 2026`;
}

/**
 * Normalizes and truncates room strings.
 * Isolates and highlights the room number (alphanumeric suffix).
 * Examples:
 *   - "PHA503-PHA503" -> roomNumber: "A503"
 *   - "PH.A503-PHA503" -> roomNumber: "A503"
 *   - "PHA503" -> roomNumber: "A503"
 *   - "PH-A503" -> roomNumber: "A503"
 *   - "PH.B205" -> roomNumber: "B205"
 *   - "B205-B205" -> roomNumber: "B205"
 *   - "B205" -> roomNumber: "B205"
 *   - "Phòng A204" -> roomNumber: "A204"
 *   - "PH101-PH101" -> roomNumber: "101"
 *
 * @param {string} rawRoom - The raw room string from portal or schedule data
 * @returns {{ raw: string, roomNumber: string, html: string, isAssigned: boolean }}
 */
export function normalizeRoom(rawRoom) {
  if (!rawRoom || typeof rawRoom !== 'string') {
    return {
      raw: '',
      roomNumber: '',
      html: '<span class="room-empty text-muted">Chưa xếp</span>',
      isAssigned: false
    };
  }

  const trimmed = rawRoom.trim();
  if (!trimmed || trimmed.toLowerCase().includes('chưa') || trimmed === '-') {
    return {
      raw: trimmed,
      roomNumber: '',
      html: '<span class="room-empty text-muted">Chưa xếp</span>',
      isAssigned: false
    };
  }

  // Handle repeated hyphenated patterns (e.g., PHA503-PHA503 or PartA-PartB)
  let candidate = trimmed;
  if (trimmed.includes('-')) {
    const parts = trimmed.split('-').map(p => p.trim()).filter(Boolean);
    if (parts.length > 0) {
      // If parts are identical, or first part has the room code, take the first part
      candidate = parts[0];
    }
  }

  // Strip prefixes: "Phòng", "Phong", "PH.", "PH-", "PH_", "PH" (if followed by alphanumeric), "P."
  let cleaned = candidate
    .replace(/^(?:Phòng|Phong)\s*/i, '')
    .replace(/^PH[\.\-_ ]?/i, '')
    .replace(/^P[\. ]/i, '')
    .trim();

  // Isolate the alphanumeric room code (e.g. A503, B205, D101, F302, 101, CS2_A101)
  // Matches building letter + room number or numbers
  const match = cleaned.match(/([A-Za-z]?\d+[A-Za-z0-9]*|[A-Za-z]+[-_]?\d+)/);
  const roomNumber = match ? match[1] : (cleaned || candidate);

  return {
    raw: trimmed,
    roomNumber: roomNumber,
    html: `<span class="room-highlight font-semibold">${roomNumber}</span>`,
    isAssigned: true
  };
}

/**
 * Maps class period spans to university session labels:
 *   1-3   -> "Ca 1" (VI) / "Session 1" (EN)
 *   4-6   -> "Ca 2" (VI) / "Session 2" (EN)
 *   7-9   -> "Ca 3" (VI) / "Session 3" (EN)
 *   10-12 -> "Ca 4" (VI) / "Session 4" (EN)
 *   Other periods (evening classes, e.g. 13-15) remain unchanged.
 *
 * @param {number|string} startPeriod - Starting period (1-based)
 * @param {number|string} endPeriod - Ending period
 * @param {string} lang - 'vi' or 'en'
 * @returns {{ mapped: boolean, sessionNumber: number|null, label: string, periodSpan: string }}
 */
export function mapSession(startPeriod, endPeriod, lang = 'vi') {
  const s = Number(startPeriod) || 1;
  const e = Number(endPeriod) || s;
  const isEn = lang === 'en';
  const prefix = isEn ? 'Session' : 'Ca';
  const periodWord = isEn ? 'Period' : 'Tiết';
  const periodSpan = s === e ? `${s}` : `${s} - ${e}`;

  if (s === 1 && e === 3) {
    return { mapped: true, sessionNumber: 1, label: `${prefix} 1`, periodSpan };
  }
  if (s === 4 && e === 6) {
    return { mapped: true, sessionNumber: 2, label: `${prefix} 2`, periodSpan };
  }
  if (s === 7 && e === 9) {
    return { mapped: true, sessionNumber: 3, label: `${prefix} 3`, periodSpan };
  }
  if (s === 10 && e === 12) {
    return { mapped: true, sessionNumber: 4, label: `${prefix} 4`, periodSpan };
  }

  // All other periods (evening classes: 13-15 or non-standard spans) remain unchanged
  return {
    mapped: false,
    sessionNumber: null,
    label: `${periodWord} ${periodSpan}`,
    periodSpan
  };
}

/**
 * Sanitizes and transforms a single raw class item during DOM parsing phase.
 * Prevents layout shifts by computing all formatted fields ahead of DOM rendering.
 *
 * @param {object} item - Raw schedule item from API or cached data
 * @param {object|string} semesterInfo - Active semester info or code
 * @param {string} lang - Current language 'vi' or 'en'
 * @returns {object} Sanitized item with formatted semester, room_number, and session_label
 */
export function sanitizeScheduleItem(item, semesterInfo, lang = 'vi') {
  if (!item) return null;

  const startP = Number(item.tiet_bat_dau) || 1;
  const count = Number(item.so_tiet) || 1;
  const endP = startP + count - 1;

  const session = mapSession(startP, endP, lang);
  const room = normalizeRoom(item.ma_phong || item.phong || '');
  const semester = formatSemester(semesterInfo, lang);

  return {
    ...item,
    start_period: startP,
    period_count: count,
    end_period: endP,
    semester: semester,
    session_label: session.label,
    is_mapped_session: session.mapped,
    session_number: session.sessionNumber,
    period_span: session.periodSpan,
    room_number: room.roomNumber,
    room_html: room.html,
    is_room_assigned: room.isAssigned
  };
}

/**
 * Sanitizes an entire schedule dataset (all weeks and their classes)
 *
 * @param {object} scheduleData - Full timetable response
 * @param {object|string} semesterInfo - Semester info
 * @param {string} lang - 'vi' or 'en'
 * @returns {object} Deep clone with sanitized class items
 */
export function sanitizeScheduleData(scheduleData, semesterInfo, lang = 'vi') {
  if (!scheduleData || !Array.isArray(scheduleData.ds_tuan_tkb)) {
    return scheduleData;
  }

  const formattedSemester = formatSemester(semesterInfo, lang);

  const sanitizedWeeks = scheduleData.ds_tuan_tkb.map(week => {
    const rawClasses = week.ds_thoi_khoa_bieu || week.ds_tkb || week.tkb || [];
    const sanitizedClasses = rawClasses.map(c => sanitizeScheduleItem(c, semesterInfo, lang));

    return {
      ...week,
      formatted_semester: formattedSemester,
      ds_thoi_khoa_bieu: sanitizedClasses,
      ds_tkb: sanitizedClasses
    };
  });

  return {
    ...scheduleData,
    formatted_semester: formattedSemester,
    ds_tuan_tkb: sanitizedWeeks
  };
}
