// The gauntlet as a plan an agent can follow: the stages in order, what each
// one reads, the call that starts it and the call that ends the run.

import { CONTEXT_FIELDS, missingContext, profileNeeds } from '../lib/evidence.mjs';
import { VERDICTS } from '../lib/parse.mjs';
import { GAUNTLET, reviewProfile } from '../lib/profiles.mjs';

/** The name a stage review is kept under and passed to later stages as. */
export function stageFile(n, profileId) {
  return `stage-${n}-${profileId}.md`;
}

/**
 * True for a profile whose method is not part of this package. Such a stage
 * runs through run_review; every other stage is answered by the agent's own model.
 */
export function runsHosted(profile) {
  return profile.hosted === true || !profile.instructions;
}

function stageInstruction({ n, total, profile, saveAs, hosted }) {
  const earlier = n > 1 ? ', the context and the earlier reviews as files' : ' and the context';
  if (hosted) {
    return `Stage ${n} of ${total}. Call run_review with profile "${profile.id}", the provider and model the researcher chose, the collected paths${earlier}. Keep the returned review as ${saveAs}.`;
  }
  return `Stage ${n} of ${total}. Call prepare_review with profile "${profile.id}", the collected paths${earlier}. Answer the request it returns yourself, as the reviewer its instructions describe: start at "# Review" and follow the output format exactly. Keep your review as ${saveAs}.`;
}

/**
 * The gauntlet plan. `context` is what the researcher has stated so far;
 * `ask` lists the Context fields a stage reads that are still empty.
 *
 * @param {unknown} [context]
 */
export function gauntletPlan(context) {
  const total = GAUNTLET.length;
  const stated = context ?? {};

  const stages = GAUNTLET.map((id, index) => {
    const n = index + 1;
    const profile = reviewProfile(id);
    const needs = profileNeeds(id);
    const saveAs = stageFile(n, id);
    const hosted = runsHosted(profile);

    return {
      n,
      profile: id,
      name: profile.name,
      question: profile.tagline,
      tool: hosted ? 'run_review' : 'prepare_review',
      reads: needs.inputs.map((input) => input.label),
      context: needs.context.map((field) => field.key),
      saveAs,
      instruction: stageInstruction({ n, total, profile, saveAs, hosted }),
    };
  });

  // Every Context field a stage reads and nobody has filled, in form order, with the stages that read it.
  const missing = new Map(stages.map((stage) => [stage.n, missingContext(stated, stage.profile)]));
  const ask = CONTEXT_FIELDS.map((field) => ({
    key: field.key,
    label: field.label,
    hint: field.hint,
    stages: stages.filter((stage) => missing.get(stage.n).includes(field.key)).map((stage) => stage.n),
  })).filter((field) => field.stages.length > 0);

  const last = stages[total - 1];
  const earlierStages = stages.slice(0, -1);
  const hostedCount = stages.filter((stage) => stage.tool === 'run_review').length;

  return {
    name: 'gauntlet',
    mode: 'bounty',
    verdicts: VERDICTS.bounty,
    hosted: {
      stages: hostedCount,
      needs: hostedCount
        ? `${hostedCount} of the ${total} stages run on the Bounty Operator server through run_review: a connection token, a provider, a model and that provider's key in this server's environment. Each one uses a hosted review; call account for the allowance. The last stage runs on an Operator plan: a free account is refused there with code operator_only.`
        : 'Every stage is answered by your own model.',
    },
    steps: [
      'Collect the draft report, the source files it cites and any proof. Name them as paths under the working directory and put the draft first.',
      'Build one context object from what the researcher has stated. The fields under "ask" are still empty: ask for them once, and leave out what the researcher does not have.',
      ...(hostedCount ? ['Ask once which provider and model to run the hosted stages on, and call account to see how many reviews the plan allows today. On a free plan, say before stage 1 that the last stage runs on Operator.'] : []),
      `Run the ${total} stages in order, each by its instruction. A stage whose tool is run_review returns the review. A stage whose tool is prepare_review returns a request you answer yourself.`,
      'Keep every review under its stage\'s saveAs name.',
      'From stage 2 on, pass every earlier review under files: its saveAs name as the name, the review text as the content.',
      'When the privacy check stops a call, show each file, line and kind of match. For a block, wait until it is redacted. For a warning, ask whether to send the files as they are, then repeat the call with acknowledgeWarnings set to true.',
      ...(hostedCount ? ['When run_review returns refused or blocked, or fails with code provider_policy, the provider or the model declined. Do not present the text as a review and do not keep it as a stage review. Say that a blocked review was not counted against the allowance. Do not call run_review again with the same model: ask for another model or provider, then run that stage again.'] : []),
      'When a stage ends in drop or hold-duplicate, show why and ask whether to continue.',
      `After stage ${total}, call build_packet with the arguments under "finish".`,
      'Show the final verdict, what each stage decided in one line, every open counterargument and every reference problem. Then give the packet.',
    ],
    stages,
    ask,
    finish: {
      tool: 'build_packet',
      arguments: {
        review: `the ${last.saveAs} review text`,
        manifest: `the manifest stage ${total} returned, unchanged`,
        context: 'the same context object',
        profile: last.profile,
        source: 'gauntlet',
        model: 'the model that wrote the reviews',
        stages: earlierStages.map((stage) => ({
          profile: stage.profile,
          verdict: `the Verdict line of ${stage.saveAs}`,
          headline: `the Headline line of ${stage.saveAs}`,
        })),
      },
    },
  };
}
