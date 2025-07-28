import { ref } from 'vue';
import { Room, createLocalAudioTrack } from 'livekit-client';

const PROXIMITY_WS      = import.meta.env.VITE_PROXIMITY_WS;
const LIVEKIT_URL       = import.meta.env.VITE_LIVEKIT_URL;
const TOKEN_SERVICE_URL = import.meta.env.VITE_LIVEKIT_TOKEN_SERVICE_URL;

export default function usePlayerPositionEmitter() {
  const nearbyPlayers = ref([]);

  let proximitySocket  = null;
  let reconnectTimer   = null;
  let guid             = null;
  let livekitRoom      = null;
  let currentRoomId    = null;
  let joinedRoom       = false;
  let localAudioTrack  = null;

  const DEBUG = true;
  function log(...args) { if (DEBUG) console.log('[usePlayerPositionEmitter]', ...args); }

  /** called once from your UI */
  function setGuid(playerGuid) {
    guid = playerGuid;
  }

  /** opens/reopens the WS */
  function connectToProximitySocket() {
    if (!guid) { log('Cannot connect: GUID not set'); return; }
    if (proximitySocket &&
        (proximitySocket.readyState === WebSocket.OPEN ||
         proximitySocket.readyState === WebSocket.CONNECTING)) {
      log('Proximity WS already open');
      return;
    }

    proximitySocket = new WebSocket(PROXIMITY_WS);
    proximitySocket.onopen = () => {
      log('Proximity WS: Connected');
      proximitySocket.send(JSON.stringify({ guid }));
    };
    proximitySocket.onerror = e => log('Proximity WS: Error', e);
    proximitySocket.onclose = () => {
      log('Proximity WS: Closed, reconnecting…');
      reconnectTimer = setTimeout(connectToProximitySocket, 2000);
    };
    proximitySocket.onmessage = e => {
      let data;
      try { data = JSON.parse(e.data); }
      catch { return log('Bad proximity JSON:', e.data); }
      handleProximityUpdate(data);
    };
  }

  /** fetch token + join/publish */
  async function joinLivekitRoom(mapId) {
    if (joinedRoom && currentRoomId === mapId) return;

    if (joinedRoom && currentRoomId !== mapId) {
      try { await livekitRoom.disconnect(); }
      catch (e) { log('Disconnect error:', e); }
      joinedRoom = false;
      currentRoomId = null;
    }

    let tokenStr;
    try {
      const res = await fetch(`${TOKEN_SERVICE_URL}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guid, room: String(mapId) }),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const payload = await res.json();
      if (typeof payload.token === 'string') {
        tokenStr = payload.token;
      } else if (payload.token && typeof payload.token.token === 'string') {
        tokenStr = payload.token.token;
      } else {
        throw new Error('Invalid token format');
      }
      log('Using token:', tokenStr);
    } catch (err) {
      return log('Token fetch error:', err);
    }

    livekitRoom = new Room();
    livekitRoom.on('trackSubscribed', (track, _, participant) => {
      if (track.kind === 'audio') {
        const el = track.attach();
        el.autoplay    = true;
        el.playsInline = true;
        el.dataset.guid = participant.identity;
        el.style.position = 'absolute';
        el.style.left     = '-9999px';
        document.body.appendChild(el);
      }
    });

    try {
      localAudioTrack = await createLocalAudioTrack({
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl : false,
      });
      await livekitRoom.connect(LIVEKIT_URL, tokenStr, {
        autoSubscribe: true,
        name: String(guid),
        room: String(mapId),
      });
      await livekitRoom.localParticipant.publishTrack(localAudioTrack);
      joinedRoom    = true;
      currentRoomId = mapId;
      log('LiveKit room connected:', mapId);
    } catch (err) {
      log('LiveKit connect failed:', err);
    }
  }

  /**
   * adjust each remote audio’s volume & spatial position
   * based on distance up to 150 yd
   */
  function updateAudioVolumes(withinRange, self) {
    if (!joinedRoom || !livekitRoom) return;

    livekitRoom.participants.forEach(part => {
      part.audioTracks.forEach(pub => {
        const track = pub.track;
        if (!track || track.kind !== 'audio') return;

        const p = withinRange.find(x => String(x.guid) === part.identity);
        let vol = 0, dx = 0, dy = 0, dz = 0;

        if (p) {
          const rawDX = p.x - (self.x||0);
          const rawDY = p.y - (self.y||0);
          const rawDZ = (p.z||0) - (self.z||0);
          dx = Number.isFinite(rawDX)? rawDX: 0;
          dy = Number.isFinite(rawDY)? rawDY: 0;
          dz = Number.isFinite(rawDZ)? rawDZ: 0;

          if (p.distance <= 30) {
            vol = 1;
          } else if (p.distance < 150) {
            vol = 1 - (p.distance - 30) / 120;
          }
          vol = Math.max(0, Math.min(1, vol));
        }

        track.setVolume(vol);
        if (track.setSpatialPosition) {
          track.setSpatialPosition(dx, dy, dz);
        }
      });
    });
  }

  /** incoming proximity update handler */
  async function handleProximityUpdate(data) {
    if (!guid || typeof data !== 'object') return;

    const all = Object.values(data).flat();
    const self = all.find(p => String(p.guid) === String(guid));
    if (!self) return log('Self GUID not in payload');

    const nearby = all
      .filter(p => String(p.guid) !== String(guid) && String(p.map) === String(self.map))
      .map(p => {
        const dx = p.x - self.x, dy = p.y - self.y, dz = (p.z||0) - (self.z||0);
        return { ...p, distance: Math.hypot(dx, dy, dz) };
      })
      .filter(p => p.distance <= 150);

    nearbyPlayers.value = nearby;
    log('Nearby players:', nearby);

    await joinLivekitRoom(self.map);
    if (joinedRoom) updateAudioVolumes(nearby, self);
  }

  /** mute/unmute your mic */
  function toggleMic(mute) {
    if (!localAudioTrack) return;
    mute ? localAudioTrack.mute() : localAudioTrack.unmute();
  }

  /** clean up on unmount */
  function dispose() {
    clearTimeout(reconnectTimer);
    proximitySocket?.close();
    livekitRoom?.disconnect();
    proximitySocket = null;
    livekitRoom    = null;
    joinedRoom     = false;
  }

  return {
    setGuid,
    connectToProximitySocket,
    dispose,
    nearbyPlayers,
    toggleMic,
  };
}