import { SlidePanel } from "./ui";

/** The product in five plain steps, shown before anyone signs in and in the guide. */
export const STEPS: { title: string; body: string }[] = [
  { title: "Set a goal", body: "Pick one measurable target, such as revenue next quarter, and connect the data that tracks it." },
  { title: "Compare options", body: "List a few things you could do, plus doing nothing. The app estimates what each is likely to return, and how risky it is." },
  { title: "Approve one", body: "Someone other than the proposer signs off. Approval is tied to the exact numbers they saw." },
  { title: "Do the work", body: "The approved option becomes a task with clear 'done when' criteria, and the team attaches proof when it is finished." },
  { title: "Measure the result", body: "Compare the people or accounts who got the change with those who did not. The result improves the next decision." },
];

export function HowItWorks() {
  return (
    <section className="hw" aria-labelledby="hw-h">
      <h2 id="hw-h" className="hw-h">
        How it works
      </h2>
      <ol className="hw-steps">
        {STEPS.map((s, i) => (
          <li key={s.title}>
            <span className="hw-n">{String(i + 1).padStart(2, "0")}</span>
            <b>{s.title}</b>
            <span>{s.body}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** Plain-language meaning of every figure and name the app shows. */
export const GLOSSARY: [string, string][] = [
  ["Expected profit gain", "The extra profit an option is likely to add over the period, after its own cost, compared with doing nothing. It is an average across the possible outcomes, weighted by how likely each is."],
  ["Expected revenue", "The extra revenue an option is likely to add compared with doing nothing, averaged the same way."],
  ["Chance of hitting the goal", "How likely the option is to reach the target you set for a single action, given the outcomes you entered."],
  ["Chance of losing money", "How likely the option is to cost more than it brings in. Your risk policy sets the highest chance you will accept."],
  ["Range", "The worst and best of the outcomes you entered; the dot marks the expected value."],
  ["Lasting advantage", "Something durable an option could leave behind, such as a reusable process or dataset. Shown separately so it never inflates the money figures."],
  ["What would change the recommendation", "Which assumptions move the answer most. If a reasonable change flips the ranking, the call is close and better evidence there is worth the most."],
  ["Policy checks", "Hard limits your company sets: budget per action, acceptable risk of loss, worst case, and how fresh the data must be. Options that fail a check cannot be chosen."],
  ["Forecast accuracy", "How close past predictions were to what happened (Brier score; lower is better), compared with simply guessing the average."],
  ["Orion", "The decision engine. It compares the options with a fixed, auditable calculation, so the same inputs always give the same answer."],
  ["Compass", "The task tracker. Approved options become Compass tasks, each linked back to the decision that created it."],
  ["Baseline", "Where the goal's number stood before you acted, measured over a stated period."],
];

export function GuidePanel({ onClose }: { onClose(): void }) {
  return (
    <SlidePanel title="How it works" kicker="Archymedes helps a company decide where to put its effort, act on that decision, and check whether it worked." onClose={onClose}>
      <ol className="hw-steps hw-steps-col">
        {STEPS.map((s, i) => (
          <li key={s.title}>
            <span className="hw-n">{String(i + 1).padStart(2, "0")}</span>
            <b>{s.title}</b>
            <span>{s.body}</span>
          </li>
        ))}
      </ol>
      <h3 className="sx-mini-h">What the numbers mean</h3>
      <dl className="sx-facts hw-glossary">
        {GLOSSARY.map(([term, meaning]) => (
          <div key={term}>
            <dt>{term}</dt>
            <dd>{meaning}</dd>
          </div>
        ))}
      </dl>
    </SlidePanel>
  );
}
