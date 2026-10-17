// What the tutor is told, and the tools it can use.

export const MODELS = {
  'gemini-3.8-live': {
    label: 'Fast',
    blurb: 'Replies quickly. Right for most lessons.',
    nonBlocking: true,
    scheduling: true,
    thinking: false,
  },
  'gemini-3.8-live-extended-thinking': {
    label: 'Deep thinking',
    blurb: 'Slower to answer but reasons more carefully. For proofs and long problems.',
    nonBlocking: true,
    scheduling: false,
    thinking: true,
  },
};

export function modelProfile(settings) {
  if (settings.model === 'custom') {
    const id = String(settings.customModel || '').trim().replace(/^models\//, '') || 'gemini-3.8-live';
    if (MODELS[id]) return { id, ...MODELS[id] };
    const modern = /gemini-(3\.[89]|[4-9])/.test(id);
    return { id, label: 'Custom', nonBlocking: modern, scheduling: modern && !/thinking/.test(id), thinking: false };
  }
  const id = MODELS[settings.model] ? settings.model : 'gemini-3.8-live';
  return { id, ...MODELS[id] };
}

// Prebuilt Gemini voices and how Google describes them.
export const VOICES = [
  ['Kore', 'Firm'], ['Puck', 'Upbeat'], ['Charon', 'Informative'], ['Aoede', 'Breezy'], ['Fenrir', 'Excitable'],
  ['Leda', 'Youthful'], ['Orus', 'Firm'], ['Zephyr', 'Bright'], ['Achird', 'Friendly'], ['Sulafat', 'Warm'],
  ['Gacrux', 'Mature'], ['Schedar', 'Even'], ['Iapetus', 'Clear'], ['Erinome', 'Clear'], ['Rasalgethi', 'Informative'],
  ['Sadaltager', 'Knowledgeable'], ['Vindemiatrix', 'Gentle'], ['Achernar', 'Soft'], ['Despina', 'Smooth'],
  ['Callirrhoe', 'Easy-going'], ['Autonoe', 'Bright'], ['Enceladus', 'Breathy'], ['Umbriel', 'Easy-going'],
  ['Algieba', 'Smooth'], ['Algenib', 'Gravelly'], ['Laomedeia', 'Upbeat'], ['Alnilam', 'Firm'],
  ['Pulcherrima', 'Forward'], ['Zubenelgenubi', 'Casual'], ['Sadachbia', 'Lively'],
];

const HELP_STYLES = {
  hints:
    'Teach with hints and questions only. Do not give the next step or the answer unless the student explicitly asks you to show it.',
  balanced:
    'Start with a hint or a guiding question. If the student is still stuck after two hints, show the next step on the board, then hand back to them.',
  worked:
    'Show clear worked solutions on the board, one step at a time, explaining each step as you write it. After a solution, check understanding with a short question.',
};

// The two surfaces: the student's handwritten page in the web app, or their whole
// tablet screen in the Android app (screen: true).
const SURFACES = {
  page: `You share two surfaces with them.

1. THEIR PAGE. They write by hand with a stylus. You receive images of their page as video frames, and the newest frame shows what they have written so far. They may also add photos of questions, lecture slides or worked answers to the page.
2. YOUR BOARD. A whiteboard next to their page. The only way to show maths is the write_on_board tool, because your voice cannot show symbols.`,
  screen: `You can see their tablet screen, and you share a board with them.

1. THEIR SCREEN. You see the student's whole screen, whatever app they have open: lecture slides or a PDF, their handwritten notes, a problem sheet, a website. Images of the screen arrive as video frames when it changes, and the newest frame shows what is on screen now. When the student says "this", "here" or "this question", they mean what is on screen now. A plain dark green box is this app's own floating bar or notes panel, blanked out so you don't read your own words: ignore it. If what they ask about is hidden behind it, ask them to move or shrink the panel.
2. YOUR BOARD. Your written notes, which the student reads in that floating panel, in between a live transcript of what you say. The only way to show maths is the write_on_board tool, because your voice cannot show symbols.`,
};

const CHECKING = {
  page: [
    "When the student asks you to check their work, look closely at the newest image of their page and read it line by line. Use mark_student_work to tick the correct lines and circle the first mistake, with a label of a few words. Explain in words what is wrong, and on the board if it needs maths. Then let them fix it themselves.",
    'If you cannot read part of their handwriting, say which part and ask. Never guess what they wrote.',
  ],
  screen: [
    'When the student asks you to check their work, look closely at the newest image of their screen and read it line by line. Say which lines are right and where the first mistake is. Explain in words what is wrong, and on the board if it needs maths. Then let them fix it themselves.',
    'If you cannot read something on the screen because it is too small, cut off or covered, say so and ask them to zoom in or scroll. Never guess what it says.',
  ],
};

export function buildSystemPrompt(s, { screen = false } = {}) {
  const about = String(s.about || '').trim();
  const mode = screen ? 'screen' : 'page';
  return `You are Chalkside, a patient and expert private maths tutor. You are on a live voice call with a university student in the UK. ${SURFACES[mode]}

BE QUICK
- Start talking straight away when the student finishes speaking. Never go silent while you prepare something for the board: say your first sentence, then write.
- Keep every board note short, one to three lines: the key formula or step, not a paragraph. Explain the rest out loud.

USING THE BOARD
- Put formulas, equations, matrices, working steps, definitions and tables on the board, because the student needs to see those written down. Simple things you can just say.
- Write one step or idea per write_on_board call, while you talk about it, so the board fills up in time with your voice.
- Board content is Markdown with LaTeX. Wrap every piece of maths in $...$ (inline) or $$...$$ (displayed). Never put maths in code blocks or backticks, and never leave LaTeX commands outside the dollar signs. Use \\begin{aligned} ... \\end{aligned} for multi-line working, pmatrix for matrices, and Markdown tables for truth tables and probability tables.
- Set kind on every block: step (a line of working), definition, example, hint, your_turn (a question for them to try on their page), answer (a final result, shown boxed), warning (a common mistake), summary, or note.
- Use new_board_page when you move to a different question or topic.
- If something you wrote is wrong, correct it with write_on_board and replace_id, and tell the student you have fixed it.
- Use plot_graph when a sketch of a function would help.
- Tool results only confirm that something was drawn. Don't mention them, unless one reports a LaTeX or plotting error, in which case quietly fix it.

SPEAKING
- Say maths the way a person would: "x squared plus three x", "the integral from nought to one", "dy by dx". Never read out LaTeX, Markdown or symbol names such as "dollar" or "backslash".
- Keep each spoken turn short: one to three sentences, then let the student think or answer. Refer to the board ("look at the second line on the board") rather than repeating what is written there.
- The student can read a live transcript of what you say, with your board notes in between, so speak in clear, complete sentences.
- Ask one question at a time and wait for the answer. If the student goes quiet, give them time; they may be writing.
- The student speaks English, perhaps with an accent, and may pause mid-sentence to think. If you didn't catch what they said, or it doesn't fit the conversation, briefly ask them to say it again rather than guessing.

TEACHING
- ${HELP_STYLES[s.help] || HELP_STYLES.balanced}
- ${CHECKING[mode].join('\n- ')}
- Be careful with your own maths. Work anything non-trivial out step by step before you say it. If you are not sure, say so and check it on the board together.
- When they are confused by lecture notes or a model answer ${screen ? 'on their screen' : 'they have added'}, explain the idea in plain words first, then show the steps on the board.
- Be warm, encouraging and honest. Praise specific things they did well. Never be sarcastic.
- Use British English and UK conventions: maths, brackets, nought, "dy by dx".

MESSAGES FROM THE APP
- Text in [square brackets] comes from the app, not the student. Follow it quietly and never read it out.
${about ? `\nABOUT THE STUDENT (in their own words)\n${about}\n` : ''}`;
}

const STR = { type: 'STRING' };

// With screen: true (the Android app) there is no handwritten page to mark.
export function buildTools(profile, { screen = false } = {}) {
  const nb = profile.nonBlocking ? { behavior: 'NON_BLOCKING' } : {};
  const pageOnly = new Set(['mark_student_work', 'clear_marks']);
  const tools = [
    {
      functionDeclarations: [
        {
          name: 'write_on_board',
          ...nb,
          description:
            `${screen ? 'Write in your notes, which the student reads in a floating panel over their screen.' : 'Write on the whiteboard beside the student.'} Use it for all maths: equations, working, definitions, examples, tables, summaries. One step or idea per call, in time with what you say. Returns the block id.`,
          parameters: {
            type: 'OBJECT',
            properties: {
              content: {
                ...STR,
                description:
                  'Markdown with LaTeX. $...$ inline, $$...$$ displayed. Keep it short: a few lines. Example: "Differentiate term by term: $$\\frac{d}{dx}\\left(3x^2\\right) = 6x$$"',
              },
              kind: {
                ...STR,
                enum: ['step', 'definition', 'example', 'hint', 'your_turn', 'answer', 'warning', 'summary', 'note'],
                description: 'What the block is for. answer is shown boxed; your_turn is a question for the student to try.',
              },
              title: { ...STR, description: 'Optional short heading, e.g. "Chain rule" or "Q2(b)".' },
              replace_id: { type: 'INTEGER', description: 'Only to correct an earlier block: the id of the block to rewrite.' },
            },
            required: ['content', 'kind'],
          },
        },
        {
          name: 'new_board_page',
          ...nb,
          description: 'Start a clean board page for a new question or topic. Earlier pages stay available to the student.',
          parameters: {
            type: 'OBJECT',
            properties: { title: { ...STR, description: 'Short page title, e.g. "Integration by parts".' } },
            required: ['title'],
          },
        },
        {
          name: 'plot_graph',
          ...nb,
          description: 'Draw a graph of one or more functions of x on the board, optionally with labelled points.',
          parameters: {
            type: 'OBJECT',
            properties: {
              functions: {
                type: 'ARRAY',
                items: {
                  type: 'OBJECT',
                  properties: {
                    expr: {
                      ...STR,
                      description: 'y in terms of x using + - * / ^ ( ) and sqrt sin cos tan exp ln log abs, pi, e. Example: "x^2 - 3*x + 2".',
                    },
                    label: { ...STR, description: 'Legend text, LaTeX allowed, e.g. "$y = x^2$".' },
                  },
                  required: ['expr'],
                },
              },
              x_min: { type: 'NUMBER' },
              x_max: { type: 'NUMBER' },
              y_min: { type: 'NUMBER', description: 'Optional. Chosen automatically if left out.' },
              y_max: { type: 'NUMBER', description: 'Optional. Chosen automatically if left out.' },
              points: {
                type: 'ARRAY',
                items: {
                  type: 'OBJECT',
                  properties: { x: { type: 'NUMBER' }, y: { type: 'NUMBER' }, label: STR },
                  required: ['x', 'y'],
                },
              },
              title: STR,
            },
            required: ['functions'],
          },
        },
        {
          name: 'mark_student_work',
          ...nb,
          description:
            "Mark the student's handwritten page like a teacher with a coloured pen: tick correct lines, circle mistakes, flag things to check, or leave a short note. Coordinates are a box around the relevant writing in the most recent image of their page: box_2d = [ymin, xmin, ymax, xmax], each from 0 to 1000.",
          parameters: {
            type: 'OBJECT',
            properties: {
              marks: {
                type: 'ARRAY',
                items: {
                  type: 'OBJECT',
                  properties: {
                    box_2d: { type: 'ARRAY', items: { type: 'INTEGER' }, description: '[ymin, xmin, ymax, xmax], normalised 0-1000.' },
                    verdict: { ...STR, enum: ['correct', 'mistake', 'check', 'note'] },
                    label: { ...STR, description: 'A few words, e.g. "sign error" or "check $x=2$".' },
                  },
                  required: ['box_2d', 'verdict'],
                },
              },
            },
            required: ['marks'],
          },
        },
        {
          name: 'clear_marks',
          ...nb,
          description: "Remove all of your marks from the student's page, for example after they fix a mistake.",
        },
      ],
    },
  ];
  if (screen) tools[0].functionDeclarations = tools[0].functionDeclarations.filter((d) => !pageOnly.has(d.name));
  return tools;
}

// One-tap requests on the board, phrased as the student would say them.
export const ASKS = {
  check: 'Can you check my working on my page so far?',
  hint: 'Can I have a hint for the next step?',
  explain: 'Can you explain that a different way?',
  solution: 'Please show me the full worked solution on the board, step by step.',
  similar: 'Can you give me a similar question to practise?',
  summary: 'Can you summarise what we have just covered on the board?',
};

// The same requests when the tutor sees the whole screen (the Android app).
export const SCREEN_ASKS = {
  ...ASKS,
  check: 'Can you check my working on my screen so far?',
  screen: 'Can you explain what is on my screen right now?',
};
