import { Markdown } from "./Markdown";

interface Props {
  text: string;
  streaming?: boolean;
}

export function StreamingText({ text, streaming }: Props) {
  return (
    <span className="streaming-text">
      <Markdown>{text}</Markdown>
      {streaming && (
        <span className="inline-block w-2 h-4 bg-blue-600 ml-0.5 animate-pulse align-middle" />
      )}
    </span>
  );
}
