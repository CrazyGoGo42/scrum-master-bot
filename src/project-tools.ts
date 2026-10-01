import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  Client,
  Events,
  GuildScheduledEventEntityType,
  GuildScheduledEventPrivacyLevel,
  MessageFlags,
  ModalBuilder,
  ModalSubmitInteraction,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  ThreadChannel
} from 'discord.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DateTime } from 'luxon';
import { config } from './config.js';

type TaskStatus = 'todo' | 'doing' | 'done';
type BlockerStatus = 'open' | 'resolved';

type ProjectTask = {
  id: string;
  title: string;
  ownerId: string;
  status: TaskStatus;
  progress?: number;
  source: 'manual' | 'daily' | 'meeting';
  createdAt: string;
  updatedAt: string;
  dailyThreadId?: string;
};

type ProjectBlocker = {
  id: string;
  text: string;
  ownerId: string;
  status: BlockerStatus;
  taskId?: string;
  source: 'manual' | 'daily';
  createdAt: string;
  resolvedAt?: string;
  dailyThreadId?: string;
};

type ProjectDecision = {
  id: string;
  title: string;
  decision: string;
  reason?: string;
  authorId: string;
  createdAt: string;
  source: 'manual' | 'meeting';
};

type MeetingNote = {
  id: string;
  messageId: string;
  authorId: string;
  discussed: string;
  decisions?: string;
  tasks?: string;
  createdAt: string;
};

type ProjectState = {
  nextTask: number;
  nextBlocker: number;
  nextDecision: number;
  nextMeetingNote: number;
  dailyImports: string[];
  tasks: ProjectTask[];
  blockers: ProjectBlocker[];
  decisions: ProjectDecision[];
  meetingNotes: MeetingNote[];
};

const EMPTY_STATE: ProjectState = {
  nextTask: 1,
  nextBlocker: 1,
  nextDecision: 1,
  nextMeetingNote: 1,
  dailyImports: [],
  tasks: [],
  blockers: [],
  decisions: [],
  meetingNotes: []
};

const statePath = process.env.PROJECT_STATE_FILE || path.join(process.cwd(), 'data', 'project-state.json');
let statePromise: Promise<ProjectState> | undefined;
let saveQueue = Promise.resolve();
let installed = false;

function memberName(id: string): string {
  return config.members.find((member) => member.discordId === id)?.name ?? id;
}

function isTeamMember(id: string): boolean {
  return config.members.some((member) => member.discordId === id);
}

function cloneEmptyState(): ProjectState {
  return JSON.parse(JSON.stringify(EMPTY_STATE)) as ProjectState;
}

async function loadState(): Promise<ProjectState> {
  if (!statePromise) {
    statePromise = (async () => {
      try {
        const raw = await fs.readFile(statePath, 'utf8');
        const parsed = JSON.parse(raw) as Partial<ProjectState>;
        return {
          ...cloneEmptyState(),
          ...parsed,
          dailyImports: Array.isArray(parsed.dailyImports) ? parsed.dailyImports : [],
          tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
          blockers: Array.isArray(parsed.blockers) ? parsed.blockers : [],
          decisions: Array.isArray(parsed.decisions) ? parsed.decisions : [],
          meetingNotes: Array.isArray(parsed.meetingNotes) ? parsed.meetingNotes : []
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.error('[Projekttools] Projektstatus konnte nicht gelesen werden.', error);
        }
        return cloneEmptyState();
      }
    })();
  }
  return statePromise;
}

async function saveState(state: ProjectState): Promise<void> {
  // Ein fehlgeschlagener Schreibvorgang darf spätere Speicherungen nicht blockieren.
  saveQueue = saveQueue.catch(() => undefined).then(async () => {
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    const temporary = `${statePath}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await fs.rename(temporary, statePath);
  });
  await saveQueue;
}

function nowIso(): string {
  return DateTime.now().setZone(config.timezone).toISO() ?? new Date().toISOString();
}

function normalize(value: string): string {
  return value.trim().replace(/^[-*]\s*/, '').replace(/\s+/g, ' ').toLocaleLowerCase('de-DE');
}

function textLines(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.replace(/^[-*]\s*/, '').trim())
    .filter(Boolean);
}

function taskId(state: ProjectState): string {
  return `T-${String(state.nextTask++).padStart(3, '0')}`;
}

function blockerId(state: ProjectState): string {
  return `B-${String(state.nextBlocker++).padStart(3, '0')}`;
}

function decisionId(state: ProjectState): string {
  return `D-${String(state.nextDecision++).padStart(3, '0')}`;
}

function meetingNoteId(state: ProjectState): string {
  return `M-${String(state.nextMeetingNote++).padStart(3, '0')}`;
}

function progressBar(progress: number): string {
  const safe = Math.max(0, Math.min(100, Math.round(progress)));
  const filled = Math.round(safe / 5);
  return `${'█'.repeat(filled)}${'░'.repeat(20 - filled)} ${safe}%`;
}

function statusLabel(status: TaskStatus): string {
  if (status === 'todo') return '📝 To Do';
  if (status === 'doing') return '🔨 Doing';
  return '✅ Done';
}

function taskLine(task: ProjectTask, blockers: ProjectBlocker[]): string {
  const progress = typeof task.progress === 'number' ? ` · ${task.progress}%` : '';
  const blocked = blockers.some((blocker) => blocker.status === 'open' && blocker.taskId === task.id) ? ' · 🧱 blockiert' : '';
  return `• **${task.id}** ${task.title} · ${memberName(task.ownerId)}${progress}${blocked}`;
}

function renderTasks(tasks: ProjectTask[], blockers: ProjectBlocker[]): string {
  const sections: string[] = ['# Aufgabenboard', '_Freiwillige Planungshilfe. Das Board ist keine zusätzliche Daily-Pflicht._'];

  for (const status of ['todo', 'doing', 'done'] as TaskStatus[]) {
    const matching = tasks.filter((task) => task.status === status);
    sections.push('', `## ${statusLabel(status)} · ${matching.length}`);
    if (matching.length === 0) {
      sections.push('- Keine Aufgaben.');
      continue;
    }

    const visible = matching.slice(-15);
    sections.push(...visible.map((task) => taskLine(task, blockers)));
    if (matching.length > visible.length) sections.push(`- … ${matching.length - visible.length} weitere`);
  }

  return sections.join('\n');
}

function renderMyTasks(tasks: ProjectTask[], blockers: ProjectBlocker[], ownerId: string): string {
  const own = tasks.filter((task) => task.ownerId === ownerId && task.status !== 'done');
  if (own.length === 0) return 'Du hast aktuell keine offenen Aufgaben im freiwilligen Board.';

  return [
    `# Offene Aufgaben · ${memberName(ownerId)}`,
    ...own.map((task) => {
      const bar = typeof task.progress === 'number' && task.status === 'doing' ? `\n  ${progressBar(task.progress)}` : '';
      return `${taskLine(task, blockers)}${bar}`;
    })
  ].join('\n');
}

function dailyTaskRow(ownerId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`project:daily-tasks:add:${ownerId}`)
      .setLabel('Ins Board übernehmen')
      .setEmoji('➕')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`project:daily-tasks:skip:${ownerId}`)
      .setLabel('Nur Daily')
      .setStyle(ButtonStyle.Secondary)
  );
}

export function meetingActionRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('project:meeting:protocol')
      .setLabel('Protokoll')
      .setEmoji('📝')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('project:meeting:task')
      .setLabel('Aufgabe')
      .setEmoji('➕')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('project:meeting:decision')
      .setLabel('Entscheidung')
      .setEmoji('📌')
      .setStyle(ButtonStyle.Success)
  );
}

function modalInput(
  id: string,
  label: string,
  style: TextInputStyle,
  placeholder: string,
  required = true,
  maxLength = 1000
): ActionRowBuilder<TextInputBuilder> {
  return new ActionRowBuilder<TextInputBuilder>().addComponents(
    new TextInputBuilder()
      .setCustomId(id)
      .setLabel(label)
      .setStyle(style)
      .setPlaceholder(placeholder)
      .setRequired(required)
      .setMaxLength(maxLength)
  );
}

function meetingProtocolModal(messageId: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`project:meeting-protocol:${messageId}`)
    .setTitle('Meeting-Protokoll')
    .addComponents(
      modalInput('discussed', 'Was wurde besprochen?', TextInputStyle.Paragraph, 'Kurze Zusammenfassung', true, 1000),
      modalInput('decisions', 'Entscheidungen', TextInputStyle.Paragraph, 'Optional, eine pro Zeile', false, 1000),
      modalInput('tasks', 'Neue Aufgaben', TextInputStyle.Paragraph, 'Optional, eine pro Zeile', false, 1000)
    );
}

function meetingTaskModal(messageId: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`project:meeting-task:${messageId}`)
    .setTitle('Aufgabe aus Meeting')
    .addComponents(modalInput('title', 'Aufgabe', TextInputStyle.Short, 'Was soll erledigt werden?', true, 200));
}

function meetingDecisionModal(messageId: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`project:meeting-decision:${messageId}`)
    .setTitle('Entscheidung dokumentieren')
    .addComponents(
      modalInput('title', 'Titel', TextInputStyle.Short, 'Kurzer Titel', true, 150),
      modalInput('decision', 'Entscheidung', TextInputStyle.Paragraph, 'Was wurde entschieden?', true, 1000),
      modalInput('reason', 'Begründung', TextInputStyle.Paragraph, 'Optional', false, 1000)
    );
}

async function addTask(
  ownerId: string,
  title: string,
  status: TaskStatus,
  source: ProjectTask['source'],
  progress?: number,
  dailyThreadId?: string
): Promise<ProjectTask> {
  const state = await loadState();
  const now = nowIso();
  const task: ProjectTask = {
    id: taskId(state),
    title: title.trim(),
    ownerId,
    status,
    progress: status === 'done' ? 100 : progress,
    source,
    createdAt: now,
    updatedAt: now,
    dailyThreadId
  };
  state.tasks.push(task);
  await saveState(state);
  return task;
}

async function addDecision(
  authorId: string,
  title: string,
  decision: string,
  reason: string | undefined,
  source: ProjectDecision['source']
): Promise<ProjectDecision> {
  const state = await loadState();
  const entry: ProjectDecision = {
    id: decisionId(state),
    title: title.trim(),
    decision: decision.trim(),
    reason: reason?.trim() || undefined,
    authorId,
    createdAt: nowIso(),
    source
  };
  state.decisions.push(entry);
  await saveState(state);
  return entry;
}

export async function offerDailyTasks(thread: ThreadChannel, ownerId: string, todayText: string): Promise<void> {
  const tasks = textLines(todayText);
  if (tasks.length === 0) return;

  await thread.send({
    content:
      `📋 **Freiwilliges Aufgabenboard**\n` +
      `Möchtest du deine heutigen Vorhaben als **Doing** übernehmen? Das ist nur eine Planungshilfe und **keine Pflicht**.\n\n` +
      tasks.map((task) => `• ${task}`).join('\n'),
    components: [dailyTaskRow(ownerId)],
    allowedMentions: { parse: [] }
  });
}

export async function trackDailyBlockers(ownerId: string, blockerText: string, dailyThreadId: string): Promise<void> {
  const lines = textLines(blockerText);
  if (lines.length === 0) return;

  const none = new Set(['keine', 'keine blocker', 'nichts', 'aktuell keine', '-']);
  const state = await loadState();
  let changed = false;

  for (const text of lines) {
    if (none.has(normalize(text))) continue;
    const exists = state.blockers.some(
      (blocker) => blocker.ownerId === ownerId && blocker.status === 'open' && normalize(blocker.text) === normalize(text)
    );
    if (exists) continue;

    state.blockers.push({
      id: blockerId(state),
      text,
      ownerId,
      status: 'open',
      source: 'daily',
      createdAt: nowIso(),
      dailyThreadId
    });
    changed = true;
  }

  if (changed) await saveState(state);
}

export async function openBlockersSummary(ownerId: string): Promise<string> {
  const state = await loadState();
  const open = state.blockers.filter((blocker) => blocker.ownerId === ownerId && blocker.status === 'open');
  if (open.length === 0) return '';
  return `\n\n🧱 **Noch offene Blocker:**\n${open.map((blocker) => `• ${blocker.id} · ${blocker.text}`).join('\n')}\n_Lösen kannst du sie jederzeit mit \`/blocker lösen\`._`;
}

export async function createScheduledMeeting(
  client: Client,
  title: string,
  start: DateTime,
  end: DateTime,
  agenda: string
): Promise<string | undefined> {
  try {
    const guild = await client.guilds.fetch(config.guildId);
    const event = await guild.scheduledEvents.create({
      name: title.slice(0, 100),
      description: (agenda || 'Teammeeting').slice(0, 1000),
      scheduledStartTime: start.toJSDate(),
      scheduledEndTime: end.toJSDate(),
      privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
      entityType: GuildScheduledEventEntityType.Voice,
      channel: config.meetingVoiceChannelId,
      reason: 'Meeting über den Scrum-Master-Bot erstellt'
    });
    return event.url;
  } catch (error) {
    console.warn('[Projekttools] Discord Scheduled Event konnte nicht erstellt werden. Das Meeting selbst bleibt bestehen.', error);
    return undefined;
  }
}

export function weeklyMarkdownAttachment(content: string, date = DateTime.now().setZone(config.timezone)): AttachmentBuilder {
  const name = `Wochenbericht_${date.toFormat('yyyy-MM-dd')}.md`;
  return new AttachmentBuilder(Buffer.from(`${content}\n`, 'utf8'), { name });
}

export function projectToolsInfoText(): string {
  return (
    `## Freiwilliges Aufgabenboard\n` +
    `Mit \`/task\` gibt es ein **optionales** To-Do/Doing/Done-Board. Aufgaben aus dem Daily können nach dem Absenden freiwillig übernommen werden. Nichts davon ist Voraussetzung für ein gültiges Daily.\n` +
    `Bei Doing-Aufgaben kann mit \`/task fortschritt\` ein eigener Fortschritt von **0–100 %** gepflegt werden. \`/task meine\` zeigt dazu einen Fortschrittsbalken.\n\n` +
    `## Blocker & Entscheidungen\n` +
    `Blocker aus Dailies werden als offen nachverfolgt und können mit \`/blocker lösen\` geschlossen werden. Manuelle Blocker sind mit \`/blocker add\` möglich. \`/entscheidung add\` dokumentiert wichtige Projektentscheidungen mit optionaler Begründung.\n\n` +
    `## Meetings & Export\n` +
    `Meetings bieten zusätzlich Protokoll-, Aufgaben- und Entscheidungsaktionen. Wenn Discord die nötige Berechtigung erlaubt, wird außerdem ein geplanter Discord-Termin für den Voice-Channel angelegt.\n` +
    `Mit \`/wochenbericht export\` lässt sich derselbe Wochenbericht als **Markdown-Datei** herunterladen.\n`
  );
}

export const projectCommands = [
  new SlashCommandBuilder()
    .setName('task')
    .setDescription('Freiwilliges To-Do / Doing / Done Board')
    .addSubcommand((sub) =>
      sub
        .setName('add')
        .setDescription('Fügt freiwillig eine Aufgabe hinzu')
        .addStringOption((option) => option.setName('titel').setDescription('Aufgabe').setRequired(true).setMaxLength(200))
        .addStringOption((option) =>
          option
            .setName('status')
            .setDescription('Startstatus')
            .addChoices(
              { name: 'To Do', value: 'todo' },
              { name: 'Doing', value: 'doing' },
              { name: 'Done', value: 'done' }
            )
        )
    )
    .addSubcommand((sub) => sub.setName('board').setDescription('Zeigt das Aufgabenboard'))
    .addSubcommand((sub) => sub.setName('meine').setDescription('Zeigt deine offenen Aufgaben'))
    .addSubcommand((sub) =>
      sub
        .setName('move')
        .setDescription('Verschiebt deine Aufgabe')
        .addStringOption((option) => option.setName('id').setDescription('z. B. T-001').setRequired(true))
        .addStringOption((option) =>
          option
            .setName('status')
            .setDescription('Neuer Status')
            .setRequired(true)
            .addChoices(
              { name: 'To Do', value: 'todo' },
              { name: 'Doing', value: 'doing' },
              { name: 'Done', value: 'done' }
            )
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('fortschritt')
        .setDescription('Setzt freiwillig den Fortschritt deiner Aufgabe')
        .addStringOption((option) => option.setName('id').setDescription('z. B. T-001').setRequired(true))
        .addIntegerOption((option) => option.setName('prozent').setDescription('0 bis 100').setRequired(true).setMinValue(0).setMaxValue(100))
    )
    .addSubcommand((sub) =>
      sub
        .setName('löschen')
        .setDescription('Löscht deine Aufgabe aus dem freiwilligen Board')
        .addStringOption((option) => option.setName('id').setDescription('z. B. T-001').setRequired(true))
    ),
  new SlashCommandBuilder()
    .setName('blocker')
    .setDescription('Blocker nachverfolgen')
    .addSubcommand((sub) =>
      sub
        .setName('add')
        .setDescription('Erfasst einen offenen Blocker')
        .addStringOption((option) => option.setName('text').setDescription('Was blockiert dich?').setRequired(true).setMaxLength(500))
        .addStringOption((option) => option.setName('aufgabe').setDescription('Optional: Task-ID, z. B. T-001'))
    )
    .addSubcommand((sub) => sub.setName('offen').setDescription('Zeigt offene Blocker'))
    .addSubcommand((sub) =>
      sub
        .setName('lösen')
        .setDescription('Markiert deinen Blocker als gelöst')
        .addStringOption((option) => option.setName('id').setDescription('z. B. B-001').setRequired(true))
    ),
  new SlashCommandBuilder()
    .setName('entscheidung')
    .setDescription('Projektentscheidungen dokumentieren')
    .addSubcommand((sub) =>
      sub
        .setName('add')
        .setDescription('Dokumentiert eine Entscheidung')
        .addStringOption((option) => option.setName('titel').setDescription('Kurzer Titel').setRequired(true).setMaxLength(150))
        .addStringOption((option) => option.setName('entscheidung').setDescription('Was wurde entschieden?').setRequired(true).setMaxLength(1000))
        .addStringOption((option) => option.setName('begründung').setDescription('Optional: Warum?').setMaxLength(1000))
    )
    .addSubcommand((sub) => sub.setName('liste').setDescription('Zeigt die letzten Entscheidungen'))
].map((command) => command.toJSON());

async function requireTeam(interaction: ChatInputCommandInteraction | ButtonInteraction | ModalSubmitInteraction): Promise<boolean> {
  if (isTeamMember(interaction.user.id)) return true;
  await interaction.reply({
    content: '⛔ Du gehörst nicht zum konfigurierten Projektteam und hast für diese Funktion keine Zuständigkeit.',
    flags: MessageFlags.Ephemeral
  });
  return false;
}

async function handleTaskCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const state = await loadState();
  const sub = interaction.options.getSubcommand();

  if (sub === 'add') {
    const title = interaction.options.getString('titel', true).trim();
    const status = (interaction.options.getString('status') ?? 'todo') as TaskStatus;
    const task = await addTask(interaction.user.id, title, status, 'manual');
    await interaction.reply({ content: `✅ **${task.id}** wurde als **${statusLabel(task.status)}** angelegt.`, flags: MessageFlags.Ephemeral });
    return;
  }

  if (sub === 'board') {
    await interaction.reply({ content: renderTasks(state.tasks, state.blockers).slice(0, 1900), flags: MessageFlags.Ephemeral });
    return;
  }

  if (sub === 'meine') {
    await interaction.reply({ content: renderMyTasks(state.tasks, state.blockers, interaction.user.id).slice(0, 1900), flags: MessageFlags.Ephemeral });
    return;
  }

  const id = interaction.options.getString('id', true).toUpperCase();
  const task = state.tasks.find((entry) => entry.id.toUpperCase() === id);
  if (!task || task.ownerId !== interaction.user.id) {
    await interaction.reply({ content: '❌ Diese Aufgabe gehört dir nicht oder wurde nicht gefunden.', flags: MessageFlags.Ephemeral });
    return;
  }

  if (sub === 'move') {
    const status = interaction.options.getString('status', true) as TaskStatus;
    task.status = status;
    if (status === 'done') task.progress = 100;
    else if (task.progress === 100) task.progress = undefined;
    task.updatedAt = nowIso();
    await saveState(state);
    await interaction.reply({ content: `✅ **${task.id}** ist jetzt **${statusLabel(status)}**.`, flags: MessageFlags.Ephemeral });
    return;
  }

  if (sub === 'fortschritt') {
    const progress = interaction.options.getInteger('prozent', true);
    task.progress = progress;
    if (progress === 100) task.status = 'done';
    else if (progress > 0 && task.status === 'todo') task.status = 'doing';
    task.updatedAt = nowIso();
    await saveState(state);
    await interaction.reply({
      content: `📊 **${task.id}** · ${progressBar(progress)} · ${statusLabel(task.status)}`,
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (sub === 'löschen') {
    state.tasks = state.tasks.filter((entry) => entry.id !== task.id);
    state.blockers.forEach((blocker) => {
      if (blocker.taskId === task.id) blocker.taskId = undefined;
    });
    await saveState(state);
    await interaction.reply({ content: `🗑️ **${task.id}** wurde aus dem freiwilligen Board entfernt.`, flags: MessageFlags.Ephemeral });
  }
}

async function handleBlockerCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const state = await loadState();
  const sub = interaction.options.getSubcommand();

  if (sub === 'add') {
    const text = interaction.options.getString('text', true).trim();
    const requestedTask = interaction.options.getString('aufgabe')?.toUpperCase();
    let linkedTask: ProjectTask | undefined;
    if (requestedTask) {
      linkedTask = state.tasks.find((task) => task.id.toUpperCase() === requestedTask && task.ownerId === interaction.user.id);
      if (!linkedTask) {
        await interaction.reply({ content: '❌ Die angegebene Aufgabe wurde nicht gefunden oder gehört dir nicht.', flags: MessageFlags.Ephemeral });
        return;
      }
    }

    const blocker: ProjectBlocker = {
      id: blockerId(state),
      text,
      ownerId: interaction.user.id,
      status: 'open',
      taskId: linkedTask?.id,
      source: 'manual',
      createdAt: nowIso()
    };
    state.blockers.push(blocker);
    await saveState(state);
    await interaction.reply({ content: `🧱 **${blocker.id}** wurde als offener Blocker gespeichert.`, flags: MessageFlags.Ephemeral });
    return;
  }

  if (sub === 'offen') {
    const open = state.blockers.filter((blocker) => blocker.status === 'open');
    const text = open.length
      ? open.map((blocker) => `• **${blocker.id}** ${blocker.text} · ${memberName(blocker.ownerId)}${blocker.taskId ? ` · ${blocker.taskId}` : ''}`).join('\n')
      : 'Keine offenen Blocker. 🎉';
    await interaction.reply({ content: `# Offene Blocker\n${text}`.slice(0, 1900), flags: MessageFlags.Ephemeral });
    return;
  }

  const id = interaction.options.getString('id', true).toUpperCase();
  const blocker = state.blockers.find((entry) => entry.id.toUpperCase() === id);
  if (!blocker || blocker.ownerId !== interaction.user.id) {
    await interaction.reply({ content: '❌ Dieser Blocker gehört dir nicht oder wurde nicht gefunden.', flags: MessageFlags.Ephemeral });
    return;
  }
  blocker.status = 'resolved';
  blocker.resolvedAt = nowIso();
  await saveState(state);
  await interaction.reply({ content: `✅ **${blocker.id}** ist als gelöst markiert.`, flags: MessageFlags.Ephemeral });
}

async function handleDecisionCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const state = await loadState();
  const sub = interaction.options.getSubcommand();

  if (sub === 'add') {
    const entry = await addDecision(
      interaction.user.id,
      interaction.options.getString('titel', true),
      interaction.options.getString('entscheidung', true),
      interaction.options.getString('begründung') ?? undefined,
      'manual'
    );
    await interaction.reply({ content: `📌 **${entry.id} · ${entry.title}** wurde im Entscheidungslog gespeichert.`, flags: MessageFlags.Ephemeral });
    return;
  }

  const latest = [...state.decisions].slice(-10).reverse();
  const text = latest.length
    ? latest.map((entry) => `• **${entry.id} · ${entry.title}** · ${entry.decision} · ${memberName(entry.authorId)}`).join('\n')
    : 'Noch keine Entscheidungen dokumentiert.';
  await interaction.reply({ content: `# Entscheidungslog\n${text}`.slice(0, 1900), flags: MessageFlags.Ephemeral });
}

function dailySection(content: string, heading: string): string[] {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = content.match(new RegExp(`(?:^|\\n)#{1,3}\\s*${escaped}\\s*\\n([\\s\\S]*?)(?=\\n#{1,3}\\s|$)`, 'i'));
  return match ? textLines(match[1]) : [];
}

async function handleDailyTaskButton(interaction: ButtonInteraction): Promise<void> {
  const parts = interaction.customId.split(':');
  const action = parts[2];
  const ownerId = parts[3];
  if (!ownerId || ownerId !== interaction.user.id) {
    await interaction.reply({ content: 'Nur die Person dieses Dailys kann diese Auswahl treffen.', flags: MessageFlags.Ephemeral });
    return;
  }

  if (action === 'skip') {
    await interaction.update({ content: '📋 Aufgabenboard übersprungen. Dein Daily bleibt natürlich vollständig gültig.', components: [] });
    return;
  }

  if (!interaction.channel?.isThread()) {
    await interaction.reply({ content: '❌ Der Daily-Thread konnte nicht erkannt werden.', flags: MessageFlags.Ephemeral });
    return;
  }

  const state = await loadState();
  if (state.dailyImports.includes(interaction.channel.id)) {
    await interaction.update({ content: '✅ Die Daily-Aufgaben wurden bereits ins Board übernommen.', components: [] });
    return;
  }

  const starter = await interaction.channel.fetchStarterMessage();
  const today = starter ? dailySection(starter.content, 'Heute') : [];
  if (today.length === 0) {
    await interaction.update({ content: '❌ Im Daily wurden keine übernehmbaren Aufgaben gefunden.', components: [] });
    return;
  }

  const created: ProjectTask[] = [];
  for (const title of today) {
    const duplicate = state.tasks.some(
      (task) => task.ownerId === ownerId && task.status !== 'done' && normalize(task.title) === normalize(title)
    );
    if (duplicate) continue;
    const now = nowIso();
    const task: ProjectTask = {
      id: taskId(state),
      title,
      ownerId,
      status: 'doing',
      source: 'daily',
      createdAt: now,
      updatedAt: now,
      dailyThreadId: interaction.channel.id
    };
    state.tasks.push(task);
    created.push(task);
  }

  state.dailyImports.push(interaction.channel.id);
  await saveState(state);
  await interaction.update({
    content: created.length
      ? `✅ ${created.length} Daily-${created.length === 1 ? 'Aufgabe wurde' : 'Aufgaben wurden'} freiwillig als **Doing** übernommen: ${created.map((task) => task.id).join(', ')}`
      : '✅ Keine neuen Aufgaben nötig. Gleiche offene Aufgaben waren bereits im Board.',
    components: []
  });
}

async function handleMeetingButton(interaction: ButtonInteraction): Promise<void> {
  if (interaction.customId === 'project:meeting:protocol') {
    await interaction.showModal(meetingProtocolModal(interaction.message.id));
    return;
  }
  if (interaction.customId === 'project:meeting:task') {
    await interaction.showModal(meetingTaskModal(interaction.message.id));
    return;
  }
  if (interaction.customId === 'project:meeting:decision') {
    await interaction.showModal(meetingDecisionModal(interaction.message.id));
  }
}

async function handleMeetingModal(interaction: ModalSubmitInteraction): Promise<void> {
  const messageId = interaction.customId.split(':').at(-1) ?? 'unbekannt';

  if (interaction.customId.startsWith('project:meeting-task:')) {
    const task = await addTask(interaction.user.id, interaction.fields.getTextInputValue('title'), 'todo', 'meeting');
    await interaction.reply({ content: `➕ **${task.id}** wurde aus dem Meeting als **To Do** angelegt.`, flags: MessageFlags.Ephemeral });
    return;
  }

  if (interaction.customId.startsWith('project:meeting-decision:')) {
    const entry = await addDecision(
      interaction.user.id,
      interaction.fields.getTextInputValue('title'),
      interaction.fields.getTextInputValue('decision'),
      interaction.fields.getTextInputValue('reason') || undefined,
      'meeting'
    );
    await interaction.reply({ content: `📌 **${entry.id} · ${entry.title}** wurde aus dem Meeting gespeichert.`, flags: MessageFlags.Ephemeral });
    return;
  }

  const state = await loadState();
  const discussed = interaction.fields.getTextInputValue('discussed').trim();
  const decisions = interaction.fields.getTextInputValue('decisions').trim();
  const tasks = interaction.fields.getTextInputValue('tasks').trim();
  const note: MeetingNote = {
    id: meetingNoteId(state),
    messageId,
    authorId: interaction.user.id,
    discussed,
    decisions: decisions || undefined,
    tasks: tasks || undefined,
    createdAt: nowIso()
  };
  state.meetingNotes.push(note);
  await saveState(state);

  await interaction.reply({
    content:
      `## 📝 Meeting-Protokoll ${note.id}\n` +
      `**Dokumentiert von:** <@${interaction.user.id}>\n\n` +
      `### Besprochen\n${discussed}\n\n` +
      `### Entscheidungen\n${decisions || 'Keine eingetragen.'}\n\n` +
      `### Aufgaben\n${tasks || 'Keine eingetragen.'}`,
    allowedMentions: { users: [interaction.user.id] }
  });
}

export function installProjectTools(client: Client): void {
  if (installed) return;
  installed = true;

  client.on(Events.InteractionCreate, (interaction) => {
    void (async () => {
      if (interaction.isChatInputCommand() && ['task', 'blocker', 'entscheidung'].includes(interaction.commandName)) {
        if (!(await requireTeam(interaction))) return;
        if (interaction.commandName === 'task') await handleTaskCommand(interaction);
        if (interaction.commandName === 'blocker') await handleBlockerCommand(interaction);
        if (interaction.commandName === 'entscheidung') await handleDecisionCommand(interaction);
        return;
      }

      if (interaction.isButton() && interaction.customId.startsWith('project:')) {
        if (!(await requireTeam(interaction))) return;
        if (interaction.customId.startsWith('project:daily-tasks:')) await handleDailyTaskButton(interaction);
        else if (interaction.customId.startsWith('project:meeting:')) await handleMeetingButton(interaction);
        return;
      }

      if (interaction.isModalSubmit() && interaction.customId.startsWith('project:meeting-')) {
        if (!(await requireTeam(interaction))) return;
        await handleMeetingModal(interaction);
      }
    })().catch((error) => console.error('[Projekttools] Interaction-Fehler', error));
  });
}
