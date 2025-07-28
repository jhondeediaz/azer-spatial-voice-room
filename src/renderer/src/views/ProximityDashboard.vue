<template>
  <div>
    <!-- GUID prompt -->
    <div v-if="!guidSet" class="guid-prompt">
      <input 
        v-model="guidInput" 
        type="number" 
        placeholder="Enter your GUID" 
      />
      <button @click="setGuidHandler">OK</button>
    </div>

    <div v-else class="main-ui">
      <label>
        <input 
          v-model="muted" 
          type="checkbox" 
          @change="toggleMuted" 
        />
        Mute (mic only)
      </label>

      <label>
        <input 
          v-model="deafened" 
          type="checkbox" 
          @change="toggleDeafen" 
        />
        Deafen (mic + speakers)
      </label>

      <button @click="resetGuid">Change GUID</button>

      <div class="debug">
        <h3>Nearby Players</h3>
        <ul>
          <li v-if="nearbyPlayers.length === 0">No players nearby</li>
          <li v-for="p in nearbyPlayers" :key="p.guid">
            GUID {{ p.guid }} — {{ p.distance !== undefined ? p.distance.toFixed(1) : '—' }} yd
          </li>
        </ul>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import { useVoiceControl } from '@composables/useVoiceControl'
import usePlayerPositionEmitter from '@composables/usePlayerPositionEmitter'

const { toggleMuted, toggleDeafen, muted, deafened } = useVoiceControl()
const { setGuid, connectToProximitySocket, dispose, nearbyPlayers } =
  usePlayerPositionEmitter()

const guidInput = ref('')
const guidSet   = ref(false)

onMounted(() => {
  const saved = localStorage.getItem('guid')
  if (saved) {
    setGuid(Number(saved))
    guidInput.value = saved
    guidSet.value    = true
    connectToProximitySocket()
  }
})

onUnmounted(() => {
  dispose()
})

function setGuidHandler() {
  if (!guidInput.value) return
  localStorage.setItem('guid', guidInput.value)
  setGuid(Number(guidInput.value))
  guidSet.value = true
  connectToProximitySocket()
}

function resetGuid() {
  localStorage.removeItem('guid')
  guidInput.value = ''
  guidSet.value    = false
}
</script>

<style>
.guid-prompt {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
input[type='number'],
button {
  padding: 0.5rem;
  font-size: 0.9rem;
  background: #2e2e40;
  color: white;
  border: none;
  border-radius: 4px;
}
button:hover {
  background: #44445c;
}
label {
  display: block;
  margin-top: 0.5rem;
}
.debug {
  margin-top: 1rem;
  font-size: 0.8rem;
}
</style>