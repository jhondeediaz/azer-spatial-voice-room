import { ref } from 'vue'

export function useVoiceControl() {
  const muted = ref(true)
  const deafened = ref(true)

  function toggleMute() {
    muted.value = !muted.value
  }

  function toggleDeafen() {
    console.log(`toggleDeafened triggered. ${deafened.value}`)
    if (deafened.value && !muted.value) muted.value = true
    deafened.value = !deafened.value
  }

  return { muted, deafened, toggleMute, toggleDeafen }
}
