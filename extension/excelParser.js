export const PERIOD_MAP = {
  1: { start: '06:45', end: '09:00' }, // Shift 1 (Tiết 1 to 3)
  4: { start: '09:15', end: '11:30' }, // Shift 2 (Tiết 4 to 6)
  7: { start: '12:30', end: '14:45' }, // Shift 3 (Tiết 7 to 9)
  10: { start: '15:00', end: '17:15' } // Shift 4 (Tiết 10 to 12)
};

export const INDIVIDUAL_PERIOD_TIMES = {
  1: { start: '06:45', end: '07:30' },
  2: { start: '07:30', end: '08:15' },
  3: { start: '08:15', end: '09:00' },
  4: { start: '09:15', end: '10:00' },
  5: { start: '10:00', end: '10:45' },
  6: { start: '10:45', end: '11:30' },
  7: { start: '12:30', end: '13:15' },
  8: { start: '13:15', end: '14:00' },
  9: { start: '14:00', end: '14:45' },
  10: { start: '15:00', end: '15:45' },
  11: { start: '15:45', end: '16:30' },
  12: { start: '16:30', end: '17:15' },
  13: { start: '18:00', end: '18:45' },
  14: { start: '18:45', end: '19:30' },
  15: { start: '19:30', end: '20:15' }
};

export function formatICSDateLocal(date) {
  const pad = (n) => String(n).padStart(2, '0');
  const y = date.getFullYear();
  const m = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  const h = pad(date.getHours());
  const min = pad(date.getMinutes());
  const s = pad(date.getSeconds());
  return `${y}${m}${d}T${h}${min}${s}`;
}

export function generateICS(events) {
  let ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//UEH Schedule Sync//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:UEH Schedule',
    'X-WR-TIMEZONE:Asia/Ho_Chi_Minh'
  ];

  events.forEach((ev, idx) => {
    const uid = `ueh_evt_${Date.now()}_${idx}@student.ueh.edu.vn`;
    ics.push(
      'BEGIN:VEVENT',
      `UID:${uid}`,
      `DTSTAMP:${formatICSDateLocal(new Date())}Z`,
      `SUMMARY:${ev.title}`,
      `DTSTART;TZID=Asia/Ho_Chi_Minh:${formatICSDateLocal(ev.start)}`,
      `DTEND;TZID=Asia/Ho_Chi_Minh:${formatICSDateLocal(ev.end)}`,
      `LOCATION:${ev.room || 'Chưa xếp phòng'}`,
      `DESCRIPTION:${(ev.description || `Mã môn: ${ev.courseCode || ''}\\nGiảng viên: ${ev.lecturer || ''}`).replace(/\n/g, '\\n')}`
    );
    if (ev.rrule) {
      ics.push(`RRULE:${ev.rrule}`);
    }
    ics.push('END:VEVENT');
  });

  ics.push('END:VCALENDAR');
  return ics.join('\r\n');
}

export function generateMakeupICS(events) {
  const makeupEvents = events.filter(ev => 
    ev.isMakeup || 
    (ev.title && ev.title.includes('Dạy bù')) || 
    (ev.description && ev.description.includes('Dạy bù'))
  );
  return generateICS(makeupEvents);
}

export function downloadICS(icsContent, filename = 'ueh_schedule.ics') {
  const blob = new Blob([icsContent], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function convertPortalScheduleToEvents(scheduleData) {
  if (!scheduleData || !scheduleData.ds_tuan_tkb) return [];
  const events = [];

  scheduleData.ds_tuan_tkb.forEach(week => {
    (week.ds_thoi_khoa_bieu || []).forEach(item => {
      const rawDate = item.ngay_hoc || '';
      const dateStr = rawDate.split('T')[0];
      if (!dateStr) return;

      const [y, m, d] = dateStr.split('-').map(Number);
      const startP = Number(item.tiet_bat_dau) || 1;
      const count = Number(item.so_tiet) || 1;
      const endP = startP + count - 1;

      const startT = INDIVIDUAL_PERIOD_TIMES[startP]?.start || '07:00';
      const endT = INDIVIDUAL_PERIOD_TIMES[endP]?.end || '09:25';

      const [sH, sM] = startT.split(':').map(Number);
      const [eH, eM] = endT.split(':').map(Number);

      const startDate = new Date(y, m - 1, d, sH, sM, 0);
      const endDate = new Date(y, m - 1, d, eH, eM, 0);

      const isMakeup = Boolean(item.is_day_bu || (item.ten_mon || '').includes('Dạy bù') || (item.ghi_chu || '').includes('Dạy bù'));
      const courseCode = item.ma_mon || '';
      const title = `${item.ten_mon}${isMakeup ? ' (Dạy bù)' : ''} (${courseCode})`;

      events.push({
        title,
        courseCode,
        room: item.ma_phong ? `Phòng ${item.ma_phong}` : 'Chưa xếp phòng',
        lecturer: item.ten_giang_vien || 'Chưa cập nhật',
        start: startDate,
        end: endDate,
        isMakeup,
        description: `Môn: ${item.ten_mon}\nMã môn: ${courseCode}\nLớp: ${item.ten_lop || item.ma_lop || ''}\nPhòng: ${item.ma_phong || 'Chưa xếp phòng'}\nGiảng viên: ${item.ten_giang_vien || 'Chưa cập nhật'}\nTiết: ${startP} - ${endP}`
      });
    });
  });

  return events;
}

function parseVietnameseDate(dateStr) {
  const parts = dateStr.split('/');
  if (parts.length !== 3) return null;
  const year = 2000 + parseInt(parts[2], 10);
  const month = parseInt(parts[1], 10) - 1;
  const day = parseInt(parts[0], 10);
  return new Date(year, month, day);
}

export function parseExcel(fileBlob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target.result);
        if (!window.XLSX) throw new Error("SheetJS không tải được");
        const workbook = window.XLSX.read(data, { type: 'array' });
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        const json = window.XLSX.utils.sheet_to_json(worksheet);

        const events = [];
        json.forEach(row => {
          const code = row['Mã MH'] || row['Mã môn'] || '';
          const title = row['Tên môn học'] || row['Tên môn'] || '';
          const room = row['Phòng'] || '';
          const lecturer = row['Giảng viên'] || '';
          const dayOfWeek = parseInt(row['Thứ'], 10);
          const startPeriod = parseInt(row['Tiết bắt đầu'], 10);

          const timeBoundaries = row['Thời gian học'];
          if (!timeBoundaries) return;

          const [startDateStr, endDateStr] = timeBoundaries.split(' đến ');
          const startDate = parseVietnameseDate(startDateStr?.trim());
          const endDate = parseVietnameseDate(endDateStr?.trim());

          if (!startDate || !endDate) return;

          const periodTime = PERIOD_MAP[startPeriod] || INDIVIDUAL_PERIOD_TIMES[startPeriod] || { start: '06:45', end: '09:00' };

          let eventStart = new Date(startDate);
          const targetDay = dayOfWeek === 8 ? 0 : dayOfWeek - 1;
          while (eventStart.getDay() !== targetDay) {
            eventStart.setDate(eventStart.getDate() + 1);
          }

          const [startH, startM] = periodTime.start.split(':');
          eventStart.setHours(parseInt(startH), parseInt(startM), 0, 0);

          let eventEnd = new Date(eventStart);
          const [endH, endM] = periodTime.end.split(':');
          eventEnd.setHours(parseInt(endH), parseInt(endM), 0, 0);

          let untilDate = new Date(endDate);
          untilDate.setHours(23, 59, 59, 0);

          const isMakeup = (title && title.includes('Dạy bù')) || false;

          events.push({
            title: `${title} (${code})`,
            courseCode: code,
            room: room ? `Phòng ${room}` : '',
            lecturer: lecturer,
            start: eventStart,
            end: eventEnd,
            isMakeup,
            description: `Môn: ${title}\nMã môn: ${code}\nGiảng viên: ${lecturer}\nPhòng: ${room}`,
            rrule: `FREQ=WEEKLY;UNTIL=${formatICSDateLocal(untilDate)}Z`
          });
        });

        resolve(events);
      } catch (err) {
        reject(err);
      }
    };
    reader.readAsArrayBuffer(fileBlob);
  });
}
