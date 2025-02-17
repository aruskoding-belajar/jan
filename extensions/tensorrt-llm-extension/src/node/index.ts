import path from 'path'
import { ChildProcessWithoutNullStreams, spawn } from 'child_process'
import tcpPortUsed from 'tcp-port-used'
import fetchRT from 'fetch-retry'
import { log } from '@janhq/core/node'
import { existsSync } from 'fs'
import decompress from 'decompress'

// Polyfill fetch with retry
const fetchRetry = fetchRT(fetch)

/**
 * The response object for model init operation.
 */
interface ModelLoadParams {
  engine_path: string
  ctx_len: number
}

// The subprocess instance for Engine
let subprocess: ChildProcessWithoutNullStreams | undefined = undefined

/**
 * Initializes a engine subprocess to load a machine learning model.
 * @param params - The model load settings.
 */
async function loadModel(params: any): Promise<{ error: Error | undefined }> {
  // modelFolder is the absolute path to the running model folder
  // e.g. ~/jan/models/llama-2
  let modelFolder = params.modelFolder

  const settings: ModelLoadParams = {
    engine_path: modelFolder,
    ctx_len: params.model.settings.ctx_len ?? 2048,
  }
  return runEngineAndLoadModel(settings)
}

/**
 * Stops a Engine subprocess.
 */
function unloadModel(): Promise<any> {
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 5000)
  debugLog(`Request to kill engine`)

  subprocess?.kill()
  return fetch(TERMINATE_ENGINE_URL, {
    method: 'DELETE',
    signal: controller.signal,
  })
    .then(() => {
      subprocess = undefined
    })
    .catch(() => {}) // Do nothing with this attempt
    .then(() => tcpPortUsed.waitUntilFree(parseInt(ENGINE_PORT), 300, 5000)) // Wait for port available
    .then(() => debugLog(`Engine process is terminated`))
    .catch((err) => {
      debugLog(
        `Could not kill running process on port ${ENGINE_PORT}. Might be another process running on the same port? ${err}`
      )
      throw 'PORT_NOT_AVAILABLE'
    })
}
/**
 * 1. Spawn engine process
 * 2. Load model into engine subprocess
 * @returns
 */
async function runEngineAndLoadModel(settings: ModelLoadParams) {
  return unloadModel()
    .then(runEngine)
    .then(() => loadModelRequest(settings))
    .catch((err) => {
      // TODO: Broadcast error so app could display proper error message
      debugLog(`${err}`, 'Error')
      return { error: err }
    })
}

/**
 * Loads a LLM model into the Engine subprocess by sending a HTTP POST request.
 */
function loadModelRequest(
  settings: ModelLoadParams
): Promise<{ error: Error | undefined }> {
  debugLog(`Loading model with params ${JSON.stringify(settings)}`)
  return fetchRetry(LOAD_MODEL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(settings),
    retries: 3,
    retryDelay: 500,
  })
    .then((res) => {
      debugLog(`Load model success with response ${JSON.stringify(res)}`)
      return Promise.resolve({ error: undefined })
    })
    .catch((err) => {
      debugLog(`Load model failed with error ${err}`, 'Error')
      return Promise.resolve({ error: err })
    })
}

/**
 * Spawns engine subprocess.
 */
function runEngine(): Promise<any> {
  debugLog(`Spawning engine subprocess...`)

  return new Promise<void>((resolve, reject) => {
    // Current directory by default
    let binaryFolder = path.join(__dirname, '..', 'bin')
    // Binary path
    const binary = path.join(
      binaryFolder,
      process.platform === 'win32' ? 'nitro.exe' : 'nitro'
    )

    const args: string[] = ['1', ENGINE_HOST, ENGINE_PORT]
    // Execute the binary
    debugLog(`Spawn nitro at path: ${binary}, and args: ${args}`)
    subprocess = spawn(binary, args, {
      cwd: binaryFolder,
      env: {
        ...process.env,
      },
    })

    // Handle subprocess output
    subprocess.stdout.on('data', (data: any) => {
      debugLog(`${data}`)
    })

    subprocess.stderr.on('data', (data: any) => {
      debugLog(`${data}`)
    })

    subprocess.on('close', (code: any) => {
      debugLog(`Engine exited with code: ${code}`)
      subprocess = undefined
      reject(`child process exited with code ${code}`)
    })

    tcpPortUsed.waitUntilUsed(parseInt(ENGINE_PORT), 300, 30000).then(() => {
      debugLog(`Engine is ready`)
      resolve()
    })
  })
}

function debugLog(message: string, level: string = 'Debug') {
  log(`[TENSORRT_LLM_NITRO]::${level}:${message}`)
}

const binaryFolder = async (): Promise<string> => {
  return path.join(__dirname, '..', 'bin')
}

const decompressRunner = async (zipPath: string) => {
  const output = path.join(__dirname, '..', 'bin')
  console.debug(`Decompressing ${zipPath} to ${output}...`)
  try {
    const files = await decompress(zipPath, output)
    console.debug('Decompress finished!', files)
  } catch (err) {
    console.error(`Decompress ${zipPath} failed: ${err}`)
  }
}

const isNitroExecutableAvailable = async (): Promise<boolean> => {
  const binary = path.join(
    __dirname,
    '..',
    'bin',
    process.platform === 'win32' ? 'nitro.exe' : 'nitro'
  )

  return existsSync(binary)
}

export default {
  binaryFolder,
  decompressRunner,
  loadModel,
  unloadModel,
  dispose: unloadModel,
  isNitroExecutableAvailable,
}
