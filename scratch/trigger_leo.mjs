
import http from 'http';

const data = JSON.stringify({ 
  type: 'POST_TRANSCRIPT',
  channelId: '1500527640107417783',
  username: 'Ryan',
  text: 'Leo, can you hear me? This is a raw system pulse test.',
  userId: '1111106883135217665'
});

const options = {
  hostname: '127.0.0.1',
  port: 3410,
  path: '/',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': data.length
  }
};

const req = http.request(options, (res) => {
  console.log(`[Pulse] Status: ${res.statusCode}`);
});

req.on('error', (e) => {
  console.error(`[Pulse] Failed: ${e.message}`);
});

req.write(data);
req.end();
