/**
 * Offscreen Document Worker for UEH Portal Auto-Login & Session Recovery.
 * Runs in an offscreen context to perform DOM-level authentication if REST
 * API token renewal requires cookie renewal, and cleanly notifies background.
 */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'OFFSCREEN_PERFORM_LOGIN') {
    performDomLogin(message.studentId, message.password)
      .then(result => sendResponse({ success: true, result }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; // Keep channel open for async response
  }
});

async function performDomLogin(studentId, password) {
  console.log('[Offscreen Worker] Performing auto-login session recovery for:', studentId);
  const endpoint = 'https://student.ueh.edu.vn/api/auth/login';
  
  const body = new URLSearchParams();
  body.append('username', studentId);
  body.append('password', password);
  body.append('grant_type', 'password');

  const res = await fetch(endpoint, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });

  if (!res.ok) {
    throw new Error(`Login failed with HTTP status ${res.status}`);
  }

  const data = await res.json();
  if (!data.access_token) {
    throw new Error(data.message || 'No access token returned from portal login.');
  }

  const studentProfile = {
    name: data.name || 'Sinh viên UEH',
    studentId: data.userName || studentId,
    email: data.principal || `${studentId}@st.ueh.edu.vn`,
    role: data.roles === 'SINHVIEN' ? 'Sinh viên' : (data.roles || 'Sinh viên')
  };

  const expiresAt = Date.now() + Math.max(300, (Number(data.expires_in) || 1800) - 60) * 1000;

  // Persist recovered session
  await new Promise(resolve => {
    chrome.storage.local.set({
      portalToken: data.access_token,
      portalTokenExpiresAt: expiresAt,
      studentProfile
    }, resolve);
  });

  console.log('[Offscreen Worker] Session healed successfully!');
  return {
    token: data.access_token,
    profile: studentProfile,
    expiresAt
  };
}
