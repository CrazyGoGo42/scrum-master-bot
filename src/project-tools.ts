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
  TextInputStyle
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
  // Text wie im Daily, falls der Blocker später mit /blocker bearbeiten geändert wurde.
  dailyText?: string;
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

const NO_BLOCKER = new Set(['keine', 'keine blocker', 'nichts', 'aktuell keine', '-']);

function dailyBlockerLines(blockerText: string): string[] {
  return textLines(blockerText).filter((text) => !NO_BLOCKER.has(normalize(text)));
}

type BlockerLike = { ownerId: string; text: string; createdAt: string; dailyThreadId?: string; dailyText?: string };

// Abgleich mit dem Daily immer über den Text, der im Daily steht – auch nach /blocker bearbeiten.
function dailyMatchText(blocker: { text: string; dailyText?: string }): string {
  return normalize(blocker.dailyText ?? blocker.text);
}

/**
 * Findet den gespeicherten Blocker zu einer Blocker-Zeile aus einem Daily:
 * 1. aus genau diesem Daily-Thread,
 * 2. sonst der zuletzt bis kurz nach dem Daily angelegte mit gleichem Text (bereits offen gewesener Blocker),
 * 3. sonst ein später mit gleichem Text angelegter (nachträglich erfasst).
 */
export function matchingDailyBlocker<T extends BlockerLike>(
  blockers: T[],
  ownerId: string,
  text: string,
  dailyThreadId: string | undefined,
  reportedAt: DateTime
): T | undefined {
  const same = blockers
    .filter((blocker) => blocker.ownerId === ownerId && dailyMatchText(blocker) === normalize(text))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const fromThread = dailyThreadId ? same.filter((blocker) => blocker.dailyThreadId === dailyThreadId) : [];
  if (fromThread.length > 0) return fromThread.at(-1);
  const limit = reportedAt.plus({ hours: 1 });
  const before = same.filter((blocker) => DateTime.fromISO(blocker.createdAt, { zone: config.timezone }) <= limit);
  return before.at(-1) ?? same[0];
}

export async function trackDailyBlockers(ownerId: string, blockerText: string, dailyThreadId: string): Promise<void> {
  const lines = dailyBlockerLines(blockerText);
  const state = await loadState();
  let changed = false;

  // Nach /daily-bearbeiten: offene Blocker dieses Dailys, die nicht mehr im Text stehen, wurden ersetzt.
  const current = new Set(lines.map(normalize));
  const replaced = state.blockers.filter(
    (blocker) =>
      blocker.source === 'daily' &&
      blocker.dailyThreadId === dailyThreadId &&
      blocker.status === 'open' &&
      !current.has(dailyMatchText(blocker))
  );
  if (replaced.length > 0) {
    state.blockers = state.blockers.filter((blocker) => !replaced.includes(blocker));
    changed = true;
  }

  for (const text of lines) {
    const exists = state.blockers.some(
      (blocker) =>
        blocker.ownerId === ownerId &&
        dailyMatchText(blocker) === normalize(text) &&
        (blocker.status === 'open' || blocker.dailyThreadId === dailyThreadId)
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

/** Übernimmt Blocker aus Dailies, die noch nicht in der Blocker-Liste stehen (z. B. Dailies ohne /daily). */
export async function importDailyBlockers(
  dailies: { ownerId: string; createdAt: DateTime; threadId?: string; blockerText: string }[]
): Promise<void> {
  const state = await loadState();
  let changed = false;

  for (const daily of dailies) {
    for (const text of dailyBlockerLines(daily.blockerText)) {
      if (matchingDailyBlocker(state.blockers, daily.ownerId, text, daily.threadId, daily.createdAt)) continue;
      state.blockers.push({
        id: blockerId(state),
        text,
        ownerId: daily.ownerId,
        status: 'open',
        source: 'daily',
        createdAt: daily.createdAt.toISO() ?? nowIso(),
        dailyThreadId: daily.threadId
      });
      changed = true;
    }
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
    .setName('blocker')
    .setDescription('Blocker nachverfolgen')
    .addSubcommand((sub) =>
      sub
        .setName('add')
        .setDescription('Erfasst einen offenen Blocker')
        .addStringOption((option) => option.setName('text').setDescription('Was blockiert dich?').setRequired(true).setMaxLength(500))
    )
    .addSubcommand((sub) => sub.setName('offen').setDescription('Zeigt offene Blocker'))
    .addSubcommand((sub) =>
      sub
        .setName('bearbeiten')
        .setDescription('Ändert den Text deines Blockers')
        .addStringOption((option) => option.setName('id').setDescription('z. B. B-001 (siehe /blocker offen)').setRequired(true))
        .addStringOption((option) => option.setName('text').setDescription('Neuer Text').setRequired(true).setMaxLength(500))
    )
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
    .addSubcommand((sub) =>
      sub
        .setName('löschen')
        .setDescription('Löscht eine Entscheidung aus dem Entscheidungslog')
        .addStringOption((option) => option.setName('id').setDescription('z. B. D-001 (siehe /entscheidung liste)').setRequired(true))
    )
].map((command) => command.toJSON());

async function requireTeam(interaction: ChatInputCommandInteraction | ButtonInteraction | ModalSubmitInteraction): Promise<boolean> {
  if (isTeamMember(interaction.user.id)) return true;
  await interaction.reply({
    content: '⛔ Du gehörst nicht zum konfigurierten Projektteam und hast für diese Funktion keine Zuständigkeit.',
    flags: MessageFlags.Ephemeral
  });
  return false;
}

async function handleBlockerCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const state = await loadState();
  const sub = interaction.options.getSubcommand();

  if (sub === 'add') {
    const text = interaction.options.getString('text', true).trim();

    const blocker: ProjectBlocker = {
      id: blockerId(state),
      text,
      ownerId: interaction.user.id,
      status: 'open',
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

  if (sub === 'bearbeiten') {
    const text = interaction.options.getString('text', true).trim();
    if (blocker.source === 'daily') blocker.dailyText ??= blocker.text;
    blocker.text = text;
    await saveState(state);
    await interaction.reply({ content: `✏️ **${blocker.id}** wurde geändert: ${text}`, flags: MessageFlags.Ephemeral });
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

  // Entscheidungen gehören dem Team: jedes Teammitglied darf löschen, nicht nur die Person, die sie eingetragen hat.
  if (sub === 'löschen') {
    const id = interaction.options.getString('id', true).trim().toUpperCase();
    const entry = state.decisions.find((decision) => decision.id.toUpperCase() === id);
    if (!entry) {
      await interaction.reply({ content: `❌ Entscheidung **${id}** wurde nicht gefunden. Die IDs zeigt \`/entscheidung liste\`.`, flags: MessageFlags.Ephemeral });
      return;
    }
    state.decisions = state.decisions.filter((decision) => decision !== entry);
    await saveState(state);
    await interaction.reply({ content: `🗑️ **${entry.id} · ${entry.title}** wurde gelöscht.`, flags: MessageFlags.Ephemeral });
    return;
  }

  const latest = [...state.decisions].slice(-10).reverse();
  const text = latest.length
    ? latest.map((entry) => `• **${entry.id} · ${entry.title}** · ${entry.decision} · ${memberName(entry.authorId)}`).join('\n')
    : 'Noch keine Entscheidungen dokumentiert.';
  await interaction.reply({ content: `# Entscheidungslog\n${text}`.slice(0, 1900), flags: MessageFlags.Ephemeral });
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
      if (interaction.isChatInputCommand() && ['blocker', 'entscheidung'].includes(interaction.commandName)) {
        if (!(await requireTeam(interaction))) return;
        if (interaction.commandName === 'blocker') await handleBlockerCommand(interaction);
        if (interaction.commandName === 'entscheidung') await handleDecisionCommand(interaction);
        return;
      }

      if (interaction.isButton() && interaction.customId.startsWith('project:')) {
        if (!(await requireTeam(interaction))) return;
        if (interaction.customId.startsWith('project:meeting:')) await handleMeetingButton(interaction);
        return;
      }

      if (interaction.isModalSubmit() && interaction.customId.startsWith('project:meeting-')) {
        if (!(await requireTeam(interaction))) return;
        await handleMeetingModal(interaction);
      }
    })().catch((error) => console.error('[Projekttools] Interaction-Fehler', error));
  });
}
