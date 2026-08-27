# Session Scheduler

Opens Claude Pro 5-hour usage windows at times you choose, so a window is
already running when you sit down to work. This glossary fixes the words used
across the UI, `schedule.json` and the cron script.

## Language

**Window**:
A Claude Pro 5-hour usage period. It begins at its first request and expires
five hours later, whatever happens in between.
_Avoid_: Session, quota, block

**Ping**:
The one-shot prompt sent through Claude Code for the sole purpose of beginning
a Window. It carries no useful work.
_Avoid_: Request, trigger, kick

**Slot**:
A single start time within a Plan, at which a Ping is due. Carries its own
on/off state.
_Avoid_: Entry, alarm, event

**Plan**:
A named set of Slots that applies to a particular kind of day. There are
exactly two: the **work-day plan** and the **weekend plan**.
_Avoid_: Schedule (that is the whole file), group, profile, preset

**Schedule**:
The complete configuration — the timezone plus both Plans. One per repo, stored
in `schedule.json`.
_Avoid_: Config, settings

**Work day**:
Monday through Friday. The mapping from weekday to Plan is fixed in code, not
user-configurable.
_Avoid_: Weekday (ambiguous: reads as "day of the week")

**Weekend**:
Saturday and Sunday, sharing one Plan.

**Fired**:
A Slot has fired when its Ping has been sent for a given local date. A Slot
fires at most once per local date.
_Avoid_: Ran, triggered, completed
