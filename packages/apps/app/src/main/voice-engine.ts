// Entry of the voice engine utility process (spawned by voice-host.ts). Bundled as
// its own main-build entry; loads only the engine (sherpa-onnx-node, external) —
// nothing of main.
import { runVoiceEngineHost, type EngineParentPort } from '@slayzone/voice/engine-host'

runVoiceEngineHost(process.parentPort as unknown as EngineParentPort)
