import { Command } from 'commander'
import { tasksCommand } from './commands/tasks'
import { projectsCommand } from './commands/projects'
import { processesCommand } from './commands/processes'
import { completionsCommand } from './commands/completions'
import { initCommand } from './commands/init'
import { ptyCommand } from './commands/pty'
import { tagsCommand } from './commands/tags'
import { templatesCommand } from './commands/templates'
import { automationsCommand } from './commands/automations'
import { panelsCommand } from './commands/panels'

const program = new Command()
  .name('slay')
  .description('SlayZone CLI')
  .version('0.1.0')
  .option('--dev', 'Use development database (slayzone.dev.sqlite)')
  .hook('preAction', (thisCommand) => {
    const root = thisCommand.parent ?? thisCommand
    if (root.opts().dev) process.env.SLAYZONE_DEV = '1'
  })

program.addCommand(tasksCommand())
program.addCommand(projectsCommand())
program.addCommand(tagsCommand())
program.addCommand(templatesCommand())
program.addCommand(automationsCommand())
program.addCommand(panelsCommand())
program.addCommand(processesCommand())
program.addCommand(completionsCommand())
program.addCommand(initCommand())
program.addCommand(ptyCommand())

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
