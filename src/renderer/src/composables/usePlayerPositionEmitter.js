import { ref, nextTick } from 'vue'
import { Room, createLocalAudioTrack } from 'livekit-client'

const PROXIMITY_WS      = import.meta.env.VITE_PROXIMITY_WS
const LIVEKIT_URL       = import.meta.env.VITE_LIVEKIT_URL
const TOKEN_SERVICE_URL = import.meta.env.VITE_LIVEKIT_TOKEN_SERVICE_URL

export default function usePlayerPositionEmitter() {
  const nearbyPlayers  = ref([])
  let ws               = null
  let reconnectTimer   = null
  let guid             = null
  let livekitRoom      = null
  let currentMap       = null
  let localAudioTrack  = null
  const audioContexts  = new Map(); // guid -> { context, panner, source, el }

  function log(...args) { console.log('[usePlayerPositionEmitter]', ...args) }

  /** Called by UI to set your GUID */
  function setGuid(x) {
    guid = x
  }

  /** Open or re-open the proximity WebSocket */
  function connectToProximitySocket() {
    if (!guid) {
      log('🚫 GUID not set')
      return
    }
    if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
      return
    }

    ws = new WebSocket(PROXIMITY_WS)
    ws.onopen = () => {
      log('✅ Proximity WS connected')
      ws.send(JSON.stringify({ guid }))
    }
    ws.onerror = e => log('⚠️ WS error', e)
    ws.onclose = () => {
      log('🔁 WS closed, reconnecting in 2s')
      reconnectTimer = setTimeout(connectToProximitySocket, 2000)
    }
    ws.onmessage = e => {
      let data
      try { data = JSON.parse(e.data) }
      catch { return log('⚠️ Bad proximity JSON:', e.data) }
      handleProximityUpdate(data)
    }
  }

  /** Fetch JWT, connect to LiveKit, publish mic */
  async function joinLivekitRoom(mapId) {
    if (livekitRoom && currentMap === mapId) return

    // disconnect previous if needed
    if (livekitRoom) {
      await livekitRoom.disconnect().catch(e => log('disconnect err', e))
      livekitRoom = null
    }

    // fetch token
    let tokenStr
    try {
      const res = await fetch(`${TOKEN_SERVICE_URL}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guid, room: String(mapId) }),
      })
      if (!res.ok) throw new Error(`status ${res.status}`)
      const json = await res.json()
      tokenStr = typeof json.token === 'string'
        ? json.token
        : json.token?.token
      if (!tokenStr) throw new Error('invalid token payload')
      log('🎟 using token…')
    } catch (err) {
      return log('⚠️ token fetch failed', err)
    }

    // new LiveKit Room
    livekitRoom = new Room()
    livekitRoom.on('trackSubscribed', (track, _, participant) => {
      // attach into the rendered <audio data-guid="…"> element
      const el = document.querySelector(`audio[data-guid="${participant.identity}"]`)
      if (el) track.attach(el)
      else console.warn('no <audio> for', participant.identity)
    })

    try {
      localAudioTrack = await createLocalAudioTrack({
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl:  false,
      })
      await livekitRoom.connect(LIVEKIT_URL, tokenStr, {
        autoSubscribe: true,
        name: String(guid),
        room: String(mapId),
      })
      await livekitRoom.localParticipant.publishTrack(localAudioTrack)
      currentMap = mapId
      log('🎧 LiveKit map', mapId)
    } catch (err) {
      log('⚠️ LiveKit connect failed', err)
    }
  }

  function safeSetValue(param, value, context) {
    if (typeof value === 'number' && isFinite(value)) {
      param.setValueAtTime(value, context.currentTime);
    }
  }

  /** Handle each proximity update */
  async function handleProximityUpdate(data) {
    if (!guid || typeof data !== 'object') return

    // flatten all players and find self
    const all = Object.values(data).flat()
    const self = all.find(p => String(p.guid) === String(guid))
    if (!self) return log('⚠️ self not in payload')

    // compute peers on same map within 150 yd
    const peers = all
      .filter(p => p.guid !== guid && String(p.map) === String(self.map))
      .map(p => ({
        guid: p.guid,
        x: p.x,
        y: p.y,
        z: p.z || 0,
        distance: Math.hypot(
          p.x - self.x,
          p.y - self.y,
          (p.z || 0) - (self.z || 0)
        )
      }))
      .filter(p => p.distance <= 150)

    nearbyPlayers.value = peers
    log('🔍 nearby', peers)

    // ensure LiveKit room joined
    await joinLivekitRoom(self.map)

    // wait for Vue to render <audio> elements, then attach tracks
    await nextTick()
    peers.forEach(p => {
      if (!livekitRoom) return;
      const participant = livekitRoom.getParticipantByIdentity(String(p.guid));
      if (participant) {
        participant.getTrackPublications().forEach(pub => {
          const track = pub.track;
          if (track && track.kind === 'audio') {
            const el = document.querySelector(`audio[data-guid="${p.guid}"]`);
            if (el) {
              track.attach(el);
              let entry = audioContexts.get(p.guid);
              if (!entry) {
                const context = new (window.AudioContext || window.webkitAudioContext)();
                const source = context.createMediaElementSource(el);
                const panner = context.createPanner();
                panner.panningModel = "HRTF";
                panner.distanceModel = "exponential";
                panner.refDistance = 100;
                panner.maxDistance = 500;
                panner.rolloffFactor = 2;
                panner.coneInnerAngle = 360;
                panner.coneOuterAngle = 360;
                panner.coneOuterGain = 1;
                // Set initial position safely
                safeSetValue(panner.positionX, p.x - self.x, context);
                safeSetValue(panner.positionY, p.y - self.y, context);
                safeSetValue(panner.positionZ, (p.z || 0) - (self.z || 0), context);
                source.connect(panner).connect(context.destination);
                audioContexts.set(p.guid, { context, panner, source, el });
              } else {
                // Update position safely
                safeSetValue(entry.panner.positionX, p.x - self.x, entry.context);
                safeSetValue(entry.panner.positionY, p.y - self.y, entry.context);
                safeSetValue(entry.panner.positionZ, (p.z || 0) - (self.z || 0), entry.context);
              }
            }
          }
        });
      }
    });
  }

  /** Mute/unmute your mic */
  function toggleMic(mute) {
    if (!localAudioTrack) return
    mute ? localAudioTrack.mute() : localAudioTrack.unmute()
  }

  /** Change the microphone device */
  async function changeMic(deviceId) {
    if (!livekitRoom) return;
    // Unpublish and stop the old track
    if (localAudioTrack) {
      await livekitRoom.localParticipant.unpublishTrack(localAudioTrack);
      localAudioTrack.stop();
      localAudioTrack = null;
    }
    // Create and publish the new track
    localAudioTrack = await createLocalAudioTrack({
      deviceId: { exact: deviceId },
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    });
    await livekitRoom.localParticipant.publishTrack(localAudioTrack);
  }

  /** Deafen / Undeafen for CPU savings */
  function setDeafened(state) {
    audioContexts.forEach(({ context, source, panner }) => {
      try {
        if (state) {
          // Disconnect graph completely to stop DSP
          source.disconnect();
          panner.disconnect();
        } else {
          // Reconnect graph
          source.connect(panner).connect(context.destination);
        }
      } catch (err) {
        console.warn('Audio graph toggle failed', err);
      }
    });
  }

  /** Cleanup on unmount */
  function dispose() {
    clearTimeout(reconnectTimer)
    ws?.close()
    livekitRoom?.disconnect()
    livekitRoom = null
    // Clean up audio contexts
    audioContexts.forEach(({ context }) => context.close());
    audioContexts.clear();
  }

  return {
    nearbyPlayers,
    setGuid,
    connectToProximitySocket,
    toggleMic,
    setDeafened,
    dispose
  }
}