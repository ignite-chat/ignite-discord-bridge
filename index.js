require('dotenv').config();
const WebSocket = require('ws');
const axios = require('axios');

const APP_KEY = 'kuvw5kc9qdwndhhhczoz';
const API_TOKEN = process.env.BOT_TOKEN; // required for auth and /@me endpoint
const AUTH_ENDPOINT = 'https://api.ignite-chat.com/v1/broadcasting/auth';
const ME_ENDPOINT = 'https://api.ignite-chat.com/v1/@me';

if (!API_TOKEN) throw new Error('BOT_TOKEN env variable is required');

let BOT_ID = null;
let socketId = null;
let ws = null;

/**
 * Fetch bot info from Ignite API
 */
async function fetchBotId() {
  try {
    const response = await axios.get(ME_ENDPOINT, {
      headers: {
        'Authorization': `Bearer ${API_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });

    BOT_ID = response.data.id;
    console.log('🤖 Bot ID:', BOT_ID);
  } catch (err) {
    console.error('🔥 Failed to fetch bot ID:', err);
    process.exit(1);
  }
}

/**
 * Start sending heartbeats to keep the connection alive
 */
function startHeartbeat(interval) {
  setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ event: 'pusher:ping' }));
      console.log('💓 Sent heartbeat ping');
    }
  }, interval);
}

/**
 * Subscribe to a private channel with auth
 * @param {string} channelName - The channel to subscribe to
 */
async function subscribeToChannel(channelName) {
  if (!socketId) {
    console.error('❌ Socket ID not yet available. Wait for connection.');
    return;
  }

  try {
    const response = await axios.post(
      AUTH_ENDPOINT,
      {
        channel_name: channelName,
        socket_id: socketId,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${API_TOKEN}`,
        },
      }
    );

    const data = response.data;
    if (!data.auth) throw new Error('No auth token returned from Ignite');

    ws.send(JSON.stringify({
      event: 'pusher:subscribe',
      data: {
        channel: channelName,
        auth: data.auth,
      },
    }));

    console.log(`📡 Subscribed to ${channelName}`);
  } catch (err) {
    console.error('🔥 Failed to subscribe:', err);
  }
}

// Main function
async function main() {
  await fetchBotId();

  const wsUrl = `wss://ws.ignite-chat.com/app/${APP_KEY}?protocol=7&client=node&version=1.0`;
  ws = new WebSocket(wsUrl);

  ws.on('open', () => {
    console.log('✅ Connected to Ignite Chat');
  });

  ws.on('message', async (raw) => {
    const message = JSON.parse(raw.toString());

    // Handle system events
    if (message.event?.startsWith('pusher:')) {
      console.log('🔔 System:', message.event);

      if (message.event === 'pusher:connection_established') {
        const data = JSON.parse(message.data);
        socketId = data.socket_id;
        console.log('🆔 Socket ID:', socketId);

        startHeartbeat(data.activity_timeout * 1000);

        // Auto-subscribe to bot channel after connection
        await subscribeToChannel(`private-bot.${BOT_ID}`);
      }

      return;
    }

    // Handle custom events
    console.log('💬 Event:', message.event);
    console.log('📦 Data:', message.data);

    // {
    //   "channel": {
    //     "id": "1359228510278778880",
    //     "created_at": "2026-01-15T18:08:50.000000Z"
    //   },
    //   "message": {
    //     "content": "d",
    //     "nonce": "1768575573332814",
    //     "channel_id": "1359228510278778880",
    //     "user_id": "1359204261409325056",
    //     "id": "1359543264834748416",
    //     "updated_at": "2026-01-16T14:59:33.000000Z",
    //     "created_at": "2026-01-16T14:59:33.000000Z",
    //     "author": {
    //       "id": "1359204261409325056",
    //       "name": "test",
    //       "avatar_url": null,
    //       "username": "test"
    //     },
    //     "user": {
    //       "id": "1359204261409325056",
    //       "name": null,
    //       "avatar_url": null,
    //       "username": "test",
    //       "is_bot": false,
    //       "is_guest": false
    //     }
    //   }
    // }
    if (message.event == 'message.created') {
      const eventData = JSON.parse(message.data);
      const msg = eventData.message;
      console.log(`📝 New message from ${msg.author.name}: ${msg.content}`);
    }
  });

  ws.on('close', () => console.log('❌ Disconnected'));
  ws.on('error', (err) => console.error('🔥 WebSocket error:', err));
}

main();
