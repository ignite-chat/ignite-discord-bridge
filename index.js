require('dotenv').config();
const WebSocket = require('ws');
const axios = require('axios');
const { Client, GatewayIntentBits } = require('discord.js');

const APP_KEY = 'kuvw5kc9qdwndhhhczoz';
const BOT_TOKEN = process.env.IGNITE_BOT_TOKEN; // Ignite Bot Token required for auth and /@me endpoint
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN; // Discord Bot Token
const AUTH_ENDPOINT = 'https://api.ignite-chat.com/v1/broadcasting/auth';
const ME_ENDPOINT = 'https://api.ignite-chat.com/v1/@me';

if (!BOT_TOKEN) throw new Error('BOT_TOKEN env variable is required');
if (!DISCORD_BOT_TOKEN) throw new Error('DISCORD_BOT_TOKEN env variable is required');

let BOT_ID = null;
let socketId = null;
let ws = null;
let discordClient = null;

// A map of bridged channels between Ignite and Discord
const bridgedChannels = new Map();

// A map of Ignite Channel ID -> Ignite Webhook URL
const igniteWebhooks = new Map();

// A map of Discord Channel ID -> Discord Webhook URL
const discordWebhooks = new Map();

// A map of bridged messages between Ignite and Discord
const messageMap = new Map();

/**
 * Fetch bot info from Ignite API
 */
async function fetchBotId() {
  try {
    const response = await axios.get(ME_ENDPOINT, {
      headers: {
        'Authorization': `Bearer ${BOT_TOKEN}`,
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
          'Authorization': `Bearer ${BOT_TOKEN}`,
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

      // Ignore messages from bots (including itself)
      if (msg.author.is_bot) {
        console.log('🤖 Ignoring bot message')
        return;
      }

      // If the message is "!ping", reply with "pong"
      if (msg.content.toLowerCase() === '!ping') {
        try {
          await axios.post(
            `https://api.ignite-chat.com/v1/channels/${msg.channel_id}/messages`,
            {
              content: 'pong',
            },
            {
              headers: {
                'Authorization': `Bearer ${BOT_TOKEN}`,
                'Content-Type': 'application/json',
              },
            }
          );
          console.log('↩️ Replied with pong');
        } catch (err) {
          console.error('🔥 Failed to send reply:', err);
        }
      }

      // If the message is "!bridge", take the first argument as a channel id to bridge
      else if (msg.content.toLowerCase().startsWith('!bridge')) {
        const parts = msg.content.split(' ');
        if (parts.length >= 2) {
          const targetChannelId = parts[1];

          console.log(`🌉 Bridging to channel ID: ${targetChannelId}`);

          // Check if this channel ID exists in Discord
          discordClient.channels.fetch(targetChannelId).then(channel => {
            if (!channel) {
              console.log(`❌ Discord Channel ID ${targetChannelId} not found`);
              return;
            }

            // Make sure the channel is a text channel
            if (channel.type !== 0) { // 0 is GuildText
              console.log(`❌ Discord Channel ID ${targetChannelId} is not a text channel`);
              return;
            }

            bridgedChannels.set(targetChannelId, msg.channel_id);
            bridgedChannels.set(msg.channel_id, targetChannelId);
            console.log(`✅ Successfully bridged Ignite Channel ID ${msg.channel_id} with Discord Channel ID ${targetChannelId} ${channel.name}`);

            axios.post(
              `https://api.ignite-chat.com/v1/channels/${msg.channel_id}/messages`,
              {
                content: 'This Ignite channel is now bridged with Discord channel #' + channel.name,
              },
              {
                headers: {
                  'Authorization': `Bearer ${BOT_TOKEN}`,
                  'Content-Type': 'application/json',
                },
              }
            ).catch(err => {
              console.error('🔥 Failed to send bridge confirmation message:', err);
            });

            // Send a message to the Discord channel confirming the bridge
            // channel.send(`This Discord channel is now bridged with Ignite channel ID ${msg.channel_id}`).catch(err => {
            //   console.error('🔥 Failed to send bridge confirmation message to Discord:', err);
            // });
          }).catch(err => {
            console.error('🔥 Error fetching Discord channel:', err);
          });
        } else {
          console.log('⚠️ !bridge command requires a channel ID argument');
        }
      }
      /**
       * Allow Ignite Chat users to kick discord users by typing !kick <Discord User ID>
       */
      else if (msg.content.toLowerCase().startsWith('!kick')) {
        const parts = msg.content.split(' ');
        if (parts.length >= 2) {
          const targetUserId = parts[1];
          console.log(`🚫 Kicking Discord User ID: ${targetUserId}`)
          discordClient.users.fetch(targetUserId).then(user => {
            if (!user) {
              console.log(`❌ Discord User ID ${targetUserId} not found`);
              return;
            }

            // Get the guild from the message
            const guild = msg.guild;
            if (!guild) {
              console.log('❌ Message not sent in a guild');
              return;
            }

            guild.members.fetch(user.id).then(member => {
              if (!member) {
                console.log(`❌ Member with ID ${targetUserId} not found in guild`);
                return;
              }
              member.kick('Kicked by command').then(() => {
                console.log(`✅ Kicked user ${targetUserId}`);
              }).catch(err => {
                console.error('🔥 Error kicking member:', err);
              });
            }).catch(err => {
              console.error('🔥 Error fetching member:', err);
            });
          }).catch(err => {
            console.error('🔥 Error fetching Discord user:', err)
          });
        } else {
          console.log('⚠️ !ban command requires a user ID argument');
        }
      }


      if (bridgedChannels.has(msg.channel_id)) {
        const discordChannelId = bridgedChannels.get(msg.channel_id);

        // Forward the message to Discord
        discordClient.channels.fetch(discordChannelId).then(channel => {
          if (!channel) {
            console.log(`❌ Discord Channel ID ${discordChannelId} not found for forwarding`);
            return;
          }

          channel.send(`💬 [Ignite] ${msg.author.name}: ${msg.content}`)
            .then((discordMsg) => {
              console.log(`➡️ Forwarded message to Discord Channel ID: ${discordChannelId}`, discordMsg.id);
              messageMap.set(msg.id, discordMsg.id);
              messageMap.set(discordMsg.id, msg.id);
            })
            .catch(err => {
              console.error('🔥 Failed to forward message to Discord:', err);
            });
        }).catch(err => {
          console.error('🔥 Error fetching Discord channel for forwarding:', err);
        });
      }
    }


    /**
     * Handle message deletions in Ignite Chat, delete corresponding message in Discord
     */
    if (message.event == 'message.deleted') {
      const eventData = JSON.parse(message.data);
      const msg = eventData.message;
      console.log(`🗑️ Message deleted: ${msg.id}`);

      // If this message was bridged, delete the corresponding message in Discord
      if (messageMap.has(msg.id)) {
        const discordMsgId = messageMap.get(msg.id);

        console.log(`🌉 Deleting bridged Discord message ID: ${discordMsgId}`);

        // Find the Discord channel that contains this message
        for (const [discordChannelId, igniteChannelId] of bridgedChannels.entries()) {
          if (igniteChannelId === msg.channel_id) {
            discordClient.channels.fetch(discordChannelId).then(channel => {
              if (!channel) {
                console.log(`❌ Discord Channel ID ${discordChannelId} not found for deletion`);
                return;
              }

              channel.messages.fetch(discordMsgId).then(discordMsg => {
                if (!discordMsg) {
                  console.log(`❌ Discord Message ID ${discordMsgId} not found for deletion`);
                  return;
                }

                discordMsg.delete().then(() => {
                  console.log(`🗑️ Deleted bridged Discord message ID: ${discordMsgId}`);
                }).catch(err => {
                  console.error('🔥 Failed to delete Discord message:', err);
                });
              }).catch(err => {
                console.error('🔥 Error fetching Discord message for deletion:', err);
              });
            }).catch(err => {
              console.error('🔥 Error fetching Discord channel for deletion:', err);
            });
          }
        }
      }
    }

    //   {
    //     "user":{
    //        "id":"1360277753638682624",
    //        "name":null,
    //        "avatar_url":null,
    //        "username":"testbot2",
    //        "is_bot":true,
    //        "is_guest":true
    //     },
    //     "guild":{
    //        "id":"1359587558387875840",
    //        "name":"Test3",
    //        "description":null,
    //        "icon_url":null,
    //        "vanity":null,
    //        "owner_id":"1359586804725972992",
    //        "created_at":"2026-01-16T17:55:33.000000Z",
    //        "channels":[
    //           {
    //              "channel_id":"1359587558404653056",
    //              "guild_id":"1359587558387875840",
    //              "name":"general",
    //              "position":0,
    //              "parent_id":"1359587558396264448",
    //              "created_at":"2026-01-16T17:55:33.000000Z",
    //              "type":0,
    //              "role_permissions":[

    //              ]
    //           },
    //           {
    //              "channel_id":"1359647854901067776",
    //              "guild_id":"1359587558387875840",
    //              "name":"Test Channel",
    //              "position":0,
    //              "parent_id":null,
    //              "created_at":"2026-01-16T21:55:09.000000Z",
    //              "type":0,
    //              "role_permissions":[

    //              ]
    //           },
    //           {
    //              "channel_id":"1359648123089059840",
    //              "guild_id":"1359587558387875840",
    //              "name":"Test",
    //              "position":0,
    //              "parent_id":"1359588709237784576",
    //              "created_at":"2026-01-16T21:56:13.000000Z",
    //              "type":0,
    //              "role_permissions":[

    //              ]
    //           },
    //           {
    //              "channel_id":"1359587558396264448",
    //              "guild_id":"1359587558387875840",
    //              "name":"Text Channels",
    //              "position":0,
    //              "created_at":"2026-01-16T17:55:33.000000Z",
    //              "type":3
    //           },
    //           {
    //              "channel_id":"1359588709237784576",
    //              "guild_id":"1359587558387875840",
    //              "name":"Test Category",
    //              "position":0,
    //              "created_at":"2026-01-16T18:00:08.000000Z",
    //              "type":3
    //           }
    //        ],
    //        "roles":[

    //        ]
    //     }
    //  }
    if (message.event == 'guild.joined') {
      const eventData = JSON.parse(message.data);
      const guild = eventData.guild;
      console.log(`🎉 Joined new guild: ${guild.name} (ID: ${guild.id})`);

      // Get all Text Channels in the guild and send a welcome message
      guild.channels.filter(c => c.type === 0).forEach(channel => {
        axios.post(
          `https://api.ignite-chat.com/v1/channels/${channel.channel_id}/messages`,
          {
            content: `Hello! I'm the official Ignite Bot, Type \`!bridge <Discord Channel ID>\` to bridge this channel with a Discord channel.`,
          },
          {
            headers: {
              'Authorization': `Bearer ${BOT_TOKEN}`,
              'Content-Type': 'application/json',
            },
          }
        ).then(() => {
          console.log(`✉️ Sent welcome message to channel ID: ${channel.channel_id}`);
        }).catch(err => {
          console.error('🔥 Failed to send welcome message:', err);
        });
      });
    }
  });

  ws.on('close', () => console.log('❌ Disconnected'));
  ws.on('error', (err) => console.error('🔥 WebSocket error:', err));
}


/**
 * Start Discord Bot
 */
function startDiscordBot() {
  discordClient = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

  discordClient.once('ready', () => console.log(`🤖 Discord Bot Logged in as ${discordClient.user.tag}`));

  /**
   * Handle new messages in Discord, forward them to Ignite Chat if the channel is bridged
   */
  discordClient.on('messageCreate', (message) => {
    if (message.author.bot) return; // Ignore bot messages

    // If this channel is bridged, forward the message to Ignite Chat
    if (bridgedChannels.has(message.channel.id)) {
      const igniteChannelId = bridgedChannels.get(message.channel.id);

      axios.post(
        `https://api.ignite-chat.com/v1/channels/${igniteChannelId}/messages`,
        {
          content: `[Discord] ${message.author.username}: ${message.content}`,
        },
        {
          headers: {
            'Authorization': `Bearer ${BOT_TOKEN}`,
            'Content-Type': 'application/json',
          },
        }
      ).then((forwardedMessage) => {
        console.log(`➡️ Forwarded message to Ignite Channel ID: ${igniteChannelId}`, forwardedMessage.data.id, message.id);
        messageMap.set(message.id, forwardedMessage.data.id);
        messageMap.set(forwardedMessage.data.id, message.id);
      }).catch(err => {
        console.error('🔥 Failed to forward message to Ignite:', err);
      });
    }
  });

  /**
   * Handle message deletions in Discord
   */
  // discordClient.on('messageDelete', (message) => {
  //   if (message.author.bot) return;

  //   // If this channel is bridged, delete the corresponding message in Ignite Chat
  //   if (bridgedChannels.has(message.channel.id)) {
  //     const igniteChannelId = bridgedChannels.get(message.channel.id);

  //     // Check if we have a mapped message ID
  //     if (messageMap.has(message.id)) {
  //       const igniteMsgId = messageMap.get(message.id);

  //       console.log(`🌉 Deleting bridged Ignite message ID: ${igniteMsgId}`);

  //       axios.delete(
  //         `https://api.ignite-chat.com/v1/channels/${igniteChannelId}/messages/${igniteMsgId}`,
  //         {
  //           headers: {
  //             'Authorization': `Bearer ${BOT_TOKEN}`,
  //             'Content-Type': 'application/json',
  //           },
  //         }
  //       ).then(() => {
  //         console.log(`🗑️ Deleted bridged Ignite message ID: ${igniteMsgId}`);
  //       }).catch(err => {
  //         console.error('🔥 Failed to delete Ignite message:', err);
  //       });
  //     }
  //   }
  // });


  discordClient.login(DISCORD_BOT_TOKEN).catch(err => console.error('🔥 Discord login error:', err));
}

startDiscordBot();
main();
