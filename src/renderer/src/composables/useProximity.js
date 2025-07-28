import { ref } from 'vue'

export default function useProximity() {
  const nearbyPlayers = ref([])
  const connected = ref(false)
  return {
    nearbyPlayers,
    connected
  }
}
