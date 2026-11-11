import { describe, expect, it } from 'vitest';
import { normalizeRrule, rruleToTasks, tasksToRrule } from '../src/core/recurrence';

describe('tasksToRrule', () => {
	it.each([
		['every day', 'FREQ=DAILY'],
		['every 3 days', 'FREQ=DAILY;INTERVAL=3'],
		['every week', 'FREQ=WEEKLY'],
		['every other week', 'FREQ=WEEKLY;INTERVAL=2'],
		['every week on Saturday', 'FREQ=WEEKLY;BYDAY=SA'],
		['every 2 weeks on Monday, Thursday', 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH'],
		['every Monday', 'FREQ=WEEKLY;BYDAY=MO'],
		['every mon and thu', 'FREQ=WEEKLY;BYDAY=MO,TH'],
		['every weekday', 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR'],
		['every month', 'FREQ=MONTHLY'],
		['every month on the 15th', 'FREQ=MONTHLY;BYMONTHDAY=15'],
		['every month on the last', 'FREQ=MONTHLY;BYMONTHDAY=-1'],
		['every month on the 2nd Tuesday', 'FREQ=MONTHLY;BYDAY=2TU'],
		['every month on the last Friday', 'FREQ=MONTHLY;BYDAY=-1FR'],
		['every year', 'FREQ=YEARLY'],
		['every 2 years', 'FREQ=YEARLY;INTERVAL=2'],
		['every week when done', 'FREQ=WEEKLY;X-PL-FROM=COMPLETION'],
	])('%s', (text, rule) => {
		expect(tasksToRrule(text)).toBe(rule);
	});

	it('returns null for forms it does not read', () => {
		expect(tasksToRrule('every January on the 15th')).toBeNull();
		expect(tasksToRrule('every blue moon')).toBeNull();
		expect(tasksToRrule('')).toBeNull();
	});
});

describe('rruleToTasks', () => {
	it('round-trips every form it writes', () => {
		for (const text of [
			'every day',
			'every 3 days',
			'every week on Saturday',
			'every 2 weeks on Monday, Thursday',
			'every weekday',
			'every month on the 15th',
			'every month on the last',
			'every month on the 2nd Tuesday',
			'every month on the last Friday',
			'every year',
			'every week when done',
		]) {
			expect(rruleToTasks(tasksToRrule(text))).toBe(text);
		}
	});

	it('returns null for rules with no Tasks text', () => {
		expect(rruleToTasks('FREQ=WEEKLY;COUNT=5')).toBeNull();
		expect(rruleToTasks('FREQ=WEEKLY;UNTIL=20271231')).toBeNull();
		expect(rruleToTasks('FREQ=HOURLY')).toBeNull();
	});
});

describe('normalizeRrule', () => {
	it('gives one spelling for the same rule', () => {
		expect(normalizeRrule('RRULE:freq=weekly;byday=th,mo;interval=1')).toBe('FREQ=WEEKLY;BYDAY=MO,TH');
		expect(normalizeRrule(null)).toBeNull();
	});
});
