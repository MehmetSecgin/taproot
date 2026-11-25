import path from 'node:path';

const TEST_STEP_MARKERS = new Set(['arrange', 'act', 'assert']);

const isTestFile = (filename) => path.relative(process.cwd(), filename).startsWith(`test${path.sep}`);

const isTestStepMarker = (comment, filename) =>
  isTestFile(filename) && comment.type === 'Line' && TEST_STEP_MARKERS.has(comment.value.trim());

const isAllowed = (comment, filename) => comment.type === 'Shebang' || isTestStepMarker(comment, filename);

const noComments = {
  meta: {
    type: 'suggestion',
    messages: {
      comment: 'Code explains itself through names and structure: rename or extract instead of commenting.',
    },
  },
  create(context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          if (!isAllowed(comment, context.filename)) {
            context.report({ loc: comment.loc, messageId: 'comment' });
          }
        }
      },
    };
  },
};

const housePlugin = {
  meta: { name: 'house' },
  rules: { 'no-comments': noComments },
};

export default housePlugin;
