
import { KEYED_CHANNELS, KEYLESS_CHANNELS, RETIRED_CHANNELS, catalogStats, ALL_CHANNELS } from './src/lanes/keyed/catalog.js'
console.log('keyed', KEYED_CHANNELS.length, 'keyless', KEYLESS_CHANNELS.length, 'retired', RETIRED_CHANNELS.length)
console.log(KEYED_CHANNELS.map(c=>c.id).join(', '))
console.log('stats', JSON.stringify(catalogStats()))
