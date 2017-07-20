'use strict'

const debug = require('debug')('bildit:npm-job-runner')

module.exports = () => {
  return {
    async runJob(jobInfo, agentFunctions) {
      debug('running npm install in job %o', jobInfo)
      await agentFunctions.executeCommand(['npm', 'install'])
      const packageJson = JSON.parse(await agentFunctions.readFileAsBuffer('package.json'))

      if ((packageJson.scripts || {}).build) {
        debug('running npm run build in job %o', jobInfo)

        await agentFunctions.executeCommand(['npm', 'run', 'build'])
      }

      if ((packageJson.scripts || {}).test) {
        debug('running npm test in job %o', jobInfo)

        await agentFunctions.executeCommand(['npm', 'run', 'build'])
      }
    },

    async supports(jobInfo) {
      return jobInfo.job.kind === 'npm'
    },
  }
}