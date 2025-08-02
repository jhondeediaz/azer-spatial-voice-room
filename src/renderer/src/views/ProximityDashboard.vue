<template>
  <div class="container">
    <!-- GUID prompt -->
    <div v-if="!guidSet" class="guid-prompt">
      <input
        v-model="guidInput"
        type="number"
        placeholder="Enter your GUID"
      />
      <button class="btn" @click="setGuidHandler">OK</button>
    </div>

    <!-- Main UI -->
    <div v-else class="main-ui">

    <div class="status-bar">
      <span class="status-label"><span :class="(connectionStatus.includes('Disconnected') ? 'Disconnected' : 'Connected')">{{ connectionStatus }}</span></span>
      <span v-if="debug" class="player-count">Players Nearby: {{ nearbyPlayers.length }}</span>
    </div>
      <!-- ⚙ Settings toggle -->
      <button v-if="!showSettings" class="settings-btn" @click="showSettings = !showSettings">
        ⚙️
      </button>

      <!-- Mic selector -->
      <div v-if="showSettings" class="settings-panel">
        <label class="control-item">
          Select mic:
          <select
            v-model="selectedMicId"
            @change="handleMicChange"
          >
            <option
              v-for="d in audioDevices"
              :key="d.deviceId"
              :value="d.deviceId"
            >
              {{ d.label || d.deviceId }}
            </option>
          </select>
        </label>
        <button class="btn small" @click="showSettings = false">
          Back
        </button>
      </div>


      <!-- Mute / Deafen controls -->
      <div v-else class="controls">
        <label class="control-item">
          <input type="checkbox" v-model="muted" />
          <span class="label-text">Mute</span>
        </label>
        <label class="control-item">
          <input type="checkbox" v-model="deafened" />
          <span class="label-text">Deafen</span>
        </label>
        <button class="btn small" @click="resetGuid">
          Change ID
        </button>
      </div>

      <!-- Debug list (scrollable if large) -->
      <div v-if="debug" class="debug">
        <h3>Nearby Players</h3>
        <ul>
          <li v-if="nearbyPlayers.length === 0">No players nearby</li>
          <li v-for="p in nearbyPlayers" :key="p.guid">
            GUID {{ p.guid }} — {{ p.distance.toFixed(1) }} yd
          </li>
        </ul>
      </div>

      <!-- Hidden audio tags -->
      <div class="audio-container" aria-hidden="true">
        <audio
          v-for="p in nearbyPlayers"
          :key="p.guid"
          :data-guid="p.guid"
          autoplay
          playsinline
          :volume="computeVolume(p.distance)"
          :muted="deafened"
        ></audio>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, watch, onMounted, onUnmounted } from 'vue'
import usePlayerPositionEmitter from '@composables/usePlayerPositionEmitter'

const {
  setGuid,
  connectToProximitySocket,
  dispose,
  nearbyPlayers,
  toggleMic,
  changeMic,
  setDeafened,
  connectionStatus
} = usePlayerPositionEmitter()

// UI state
const guidInput     = ref('')
const guidSet       = ref(false)
const muted         = ref(false)
const deafened      = ref(false)
const showSettings  = ref(false)
const audioDevices  = ref([])
const selectedMicId = ref('')
const debug         = ref(import.meta.env.VITE_DEBUG_MODE === 'true')

// fade curve
function computeVolume(d) {
  if (d <= 10) return 1
  if (d >= 150) return 0
  return 1 - (d - 10) / 140
}

// keep mute/deafen rules
watch(muted, v => {
  if (!v && deafened.value) deafened.value = false
  toggleMic(v)
})
watch(deafened, v => {
  if (v) muted.value = true
  toggleMic(muted.value)
  setDeafened(v)
})

/** Enumerator */
async function updateDeviceList() {
  const devs = await navigator.mediaDevices.enumerateDevices()
  audioDevices.value = devs.filter(d => d.kind === 'audioinput')
  if (audioDevices.value.length) {
    selectedMicId.value = audioDevices.value[0].deviceId
  }
}

/** Apply changeMic + reapply mute state */
async function handleMicChange() {
  await changeMic(selectedMicId.value)
  // re-mute if needed
  toggleMic(muted.value)
}

onMounted(async () => {
  await updateDeviceList()
  const saved = localStorage.getItem('guid')
  if (saved) {
    setGuid(Number(saved))
    guidInput.value = saved
    guidSet.value   = true
    connectToProximitySocket()
  }
})

onUnmounted(() => dispose())

async function setGuidHandler() {
  if (!guidInput.value) return
  localStorage.setItem('guid', guidInput.value)
  setGuid(Number(guidInput.value))
  guidSet.value = true
  connectToProximitySocket()
}

function resetGuid() {
  localStorage.removeItem('guid')
  guidInput.value = ''
  guidSet.value   = false
}
</script>
<style>
/* container & font */
.container {
  font-family: monospace;
  background: #1e1e2f;
  color: #a2ff99;
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow-y: auto;
}

/* card styles */
.guid-prompt,
.main-ui {
  width: 280px;
  max-width: 100%;
  margin: auto;
  background: #23233a;
  border-radius: 8px;
  box-shadow: 0 2px 8px rgba(0,0,0,0.2);
  padding: 0.75rem;
}

/* inputs & buttons */
input[type='number'] {
  width: 210px;
  padding: 0.5rem;
  margin-right: 0.5rem;
  background: #2e2e40;
  color: #a2ff99;
  border: none;
  border-radius: 4px;
}
.btn {
  background: #4fc3f7;
  color: #1e1e2f;
  border: none;
  border-radius: 4px;
  padding: 0.4rem 0.8rem;
  cursor: pointer;
  margin-top: 0.5rem;
  box-shadow: 0 0 6px rgba(79,195,247,0.7);
  animation: pulse 1.5s infinite;
}
.btn:hover {
  background: #82b1ff;
  box-shadow: 0 0 12px rgba(130,177,255,0.7);
}
.btn.small {
  font-size: 0.85rem;
  padding: 0.3rem 0.6rem;
}

/* gear icon */
.settings-btn {
  background: none;
  border: none;
  color: #a2ff99;
  font-size: 1.2rem;
  float: right;
  cursor: pointer;
}

/* controls & settings layout */
.controls,
.settings-panel {
  margin-top: 1rem;
}
.control-item {
  white-space: nowrap;
  display: block;
  margin-bottom: 0.5rem;
}
.label-text {
  margin-left: 0.25rem;
}

/* debug list */
.debug {
  margin-top: 1rem;
  background: #222;
  border-radius: 6px;
  padding: 0.5rem;
  max-height: 120px;
  overflow-y: auto;
  font-size: 0.8rem;
}
.debug h3 {
  margin: 0 0 0.5rem;
  font-size: 1rem;
}
.debug ul {
  padding-left: 1.2rem;
  margin: 0;
}
.debug li {
  margin-bottom: 0.25rem;
}

/* hidden audio players */
.audio-container {
  display: none;
}
/* join-button glow */
@keyframes pulse {
  0%   { box-shadow: 0 0 6px rgba(79,195,247,0.7); }
  50%  { box-shadow: 0 0 14px rgba(79,195,247,0.8); }
  100% { box-shadow: 0 0 6px rgba(79,195,247,0.7); }
}

.settings-panel select {
  width: 180px;
  max-width: 100%;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* optional: make sure the select’s inner text is also clipped */
.settings-panel select option {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.status-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 0.85rem;
  margin-bottom: 0.5rem;
  color: #7aff7a;
}
.status-label .Connecting {
  color: #f7c14f;
}
.status-label .Connected {
  color: #4fff4f;
}
.status-label .Disconnected {
  color: #ff4f4f;
}
</style>