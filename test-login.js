const fetch = require('node-fetch');
async function test() {
  const body = new URLSearchParams();
  body.append('username', 'test');
  body.append('password', 'test');
  body.append('grant_type', 'password');
  
  const res = await fetch('https://student.ueh.edu.vn/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });
  const data = await res.json();
  console.log(data);
}
test();
