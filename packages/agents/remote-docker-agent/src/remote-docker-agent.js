const path = require('path')
const debug = require('debug')('bildit:remote-docker-agent')
const Docker = require('dockerode')
const tar = require('tar-stream')

module.exports = async ({
  pluginConfig: {
    image = 'alpine',
    start = ['sleep', '100000000'],
    user = 'root',
    workdir = '/usr/work',
  },
}) => {
  const docker = new Docker({Promise})
  const runningAgents = new Map()
  const waitingAgents = new Map()

  const info = agent => ({
    container: runningAgents.get(agent.repository).container,
    repository: agent.repository,
  })

  return {
    async getInstanceForJob({repository}) {
      if (waitingAgents.has(repository)) {
        runningAgents.set(repository, waitingAgents.get(repository))
        waitingAgents.delete(repository)

        return {repository}
      }

      const container = await createContainer(repository)

      runningAgents.set(repository, {container})

      await fetchRepo(executeCommand, repository)

      return {repository}
    },

    executeCommand,

    async readFileAsBuffer(agentInstance, fileName) {
      const {container} = info(agentInstance)
      const fullFilename = path.join(workdir, fileName)

      debug('reading file %s in container %s', fullFilename, container.id.slice(0, 6))
      const fileContent = await tarStreamToFileContent(
        await container.getArchive({path: fullFilename}),
      )
      debug('read and got %s', fileContent.toString())

      return fileContent
    },

    async writeBufferToFile(agentInstance, fileName, buffer) {
      const {container, directory} = info(agentInstance)

      const fullFilename = path.resolve(directory, fileName)

      const dirname = path.dirname(fullFilename)

      debug('creating directory %s in container %s', dirname, container.id)
      await executeCommand(agentInstance, ['mkdir', '-p', dirname])

      debug(
        'writing buffer (length %d) to file %s in container %s',
        buffer.length,
        fullFilename,
        container.id,
      )

      await container.putArchive(toTarStream(path.basename(fullFilename), buffer), {
        path: dirname,
      })
    },

    async homeDir(agentInstance) {
      const homeDir = await executeCommand(agentInstance, ['echo', '$HOME'], {
        cwd: '/',
        returnOutput: true,
      })

      debug('home dir is %s', homeDir)

      return homeDir.trim()
    },

    async createSymlink(agentInstance, link, target) {
      throw new Error('symlinking is not supported in remote-docker-agent')
    },

    async finalize() {
      await Promise.all(
        [...waitingAgents, ...runningAgents].map(async ([_, {container}]) => {
          debug('killing container %s', container.id)

          await container.remove({force: true, v: true})
        }),
      )
    },
  }

  async function executeCommand(agentInstance, commandArgs, {cwd, returnOutput} = {}) {
    const {container} = info(agentInstance)

    const finalCommand = cwd ? ['sh', '-c', `cd '${cwd}' && ${commandArgs.join(' ')}`] : commandArgs
    debug(
      'dispatching command %o in directory %s, container %s',
      finalCommand,
      cwd ? path.join(workdir, cwd) : '<default>',
      container.id.slice(0, 6),
    )
    debug('executing %o in container %s', commandArgs, container.id.slice(0, 6))
    const execution = await container.exec({
      Cmd: finalCommand,
      AttachStdout: true,
      AttachStderr: true,
      Tty: !returnOutput,
    })
    const execStream = await execution.start({Tty: !returnOutput})
    let output = ''
    const passThrough = require('through2')(function(chunk, enc, cb) {
      output += chunk.toString()
      process.stdout.write(chunk.toString())
      this.push(chunk)
      cb()
    })
    if (returnOutput) {
      container.modem.demuxStream(execStream.output, passThrough, passThrough)
    }
    await new Promise((resolve, reject) => {
      if (!returnOutput) {
        execStream.output.on('data', data => {
          process.stdout.write(data.toString())
        })
      }
      execStream.output.on('error', reject).on('end', resolve)
    })
    const {ExitCode: code} = await execution.inspect()
    debug('executed %o in container %s with exit %d', commandArgs, container.id.slice(0, 6), code)
    if (code !== 0) throw new Error(`Command failed with errorcode ${code}`)

    if (returnOutput) {
      return output
    }
  }

  async function createContainer() {
    const container = await docker.createContainer({
      Image: image,
      Tty: true,
      Cmd: start,
      WorkingDir: workdir,
      User: user,
    })
    debug('created container %s from image %s, workdir %s', container.id, image, workdir)
    await container.start()
    debug('started container %s', container.id)

    return container
  }
}

async function tarStreamToFileContent(tarStream) {
  return new Promise((resolve, reject) => {
    const extract = tar.extract()

    extract
      .on('entry', (header, stream, next) => {
        let content = new Buffer(0)
        stream
          .on('data', data => (content = Buffer.concat([content, data])))
          .on('end', () => {
            resolve(content)
            next()
          })
          .on('error', reject)
          .resume() // just auto drain the stream
      })
      .on('error', reject)

    tarStream.pipe(extract)
  })
}

function toTarStream(fileName, buffer) {
  const pack = tar.pack()

  pack.entry({name: fileName}, buffer)

  pack.finalize()

  return pack
}

async function fetchRepo(executeCommand, repository) {
  debug('cloning repository %s', repository)

  const agentInstance = {repository}

  await executeCommand(agentInstance, ['git', 'clone', repository, '.'])
}