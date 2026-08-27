# Two fixed day-plans, not per-slot day tags

Start times are grouped into exactly two plans, work-day (Mon-Fri) and weekend
(Sat-Sun), with the day-to-plan mapping fixed in code. The more general model -
a `days` array on each slot - was rejected because the app's whole job is
answering "when do my windows open today," and a single mixed list with
`Mon-Fri` / `Sat-Sun` badges turns that from a view into a mental filter. The
cost is duplication: a time you want every day exists in both plans.
