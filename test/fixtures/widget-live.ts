import { ActivityCollector } from "../../src/widget-activity.ts";
import { LiveActivityPublisher, LiveActivityReader } from "../../src/widget-live.ts";
import { titlePublisher, WidgetTitleMirrors } from "../../src/widget-title.ts";

const collector = new ActivityCollector();
let publisher: LiveActivityPublisher | undefined;
const reader = new LiveActivityReader();
const titleReader = new WidgetTitleMirrors();
let title: ReturnType<typeof titlePublisher> | undefined;
type Command = {
	key: number;
	op: string;
	sessionId?: string;
	launchId?: string;
	id?: string;
	name?: string;
	parent?: string;
	text?: string;
};
async function command(c: Command): Promise<unknown> {
	if (c.op === "titlePublish") {
		title?.stop();
		title = titlePublisher(c.sessionId!);
		title.publish(c.text);
		return null;
	}
	if (c.op === "titleRead") return titleReader.read(c.sessionId!) ?? null;
	if (c.op === "init") {
		publisher?.stop();
		await publisher?.closed();
		publisher = new LiveActivityPublisher(c.sessionId!, c.launchId);
		publisher.publish(undefined);
		await publisher.flush();
		return publisher.generation;
	}
	if (c.op === "read") return (await reader.read(c.sessionId!, c.launchId!)) ?? null;
	if (c.op === "start") collector.start(c.id!, c.name!, c.parent);
	if (c.op === "end") collector.end(c.id!);
	if (c.op === "message") {
		collector.messageStart();
		collector.delta(c.text!);
	}
	if (c.op === "messageEnd") collector.messageEnd();
	if (c.op === "settled") collector.clear();
	if (c.op === "stop") {
		title?.stop();
		publisher?.stop();
		await publisher?.closed();
		return null;
	}
	publisher?.publish(collector.snapshot());
	await publisher?.flush();
	return null;
}
process.on("message", (c: Command) => {
	void command(c).then(
		(result) => process.send?.({ key: c.key, result }),
		(error) => process.send?.({ key: c.key, error: String(error) }),
	);
});
process.send?.({ ready: true });
