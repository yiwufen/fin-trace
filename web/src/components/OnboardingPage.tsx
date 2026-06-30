import { useState } from "react";

/**
 * 新手引导页（注册后首次进入）。
 * 3 步图文说明：如何装 App、如何提问、额度说明。
 * 完成后点"开始使用"进入 /app。
 * 用 localStorage 标记已看过，避免重复打扰。
 */
export function OnboardingPage() {
  const [step, setStep] = useState(0);

  const finish = () => {
    try {
      localStorage.setItem("fin-trace-onboarded", "1");
    } catch {
      // localStorage 不可用也无妨，直接进 app
    }
    window.location.href = "/app";
  };

  const steps = [
    {
      icon: (
        <svg className="w-12 h-12" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z" />
        </svg>
      ),
      title: "装到桌面，像 App 一样用",
      desc: (
        <>
          <p>用 <strong>Chrome</strong> 打开本页面（不要在微信里直接打开）。</p>
          <p className="mt-2">点右上角 <strong>⋮ 菜单</strong> → 选 <strong>"添加到主屏幕"</strong>。</p>
          <p className="mt-2 text-xs text-gray-400">桌面会出现图标，点开即可全屏使用，无需每次输网址。</p>
        </>
      ),
    },
    {
      icon: (
        <svg className="w-12 h-12" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 3v-3z" />
        </svg>
      ),
      title: "怎么提问效果最好",
      desc: (
        <>
          <p>直接用自然语言描述你想了解的问题，例如：</p>
          <ul className="mt-2 space-y-1 text-xs text-gray-500 ml-1">
            <li>· "分析宁德时代的欧洲布局和台积电的关系"</li>
            <li>· "芯片管制对英伟达供应链的影响"</li>
            <li>· "某某公司的上下游集中度风险"</li>
          </ul>
          <p className="mt-2 text-xs text-gray-400">Agent 会在金融知识图谱上多跳推理，每一步都有据可查。一次探索通常需要 3-10 分钟。</p>
        </>
      ),
    },
    {
      icon: (
        <svg className="w-12 h-12" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      ),
      title: "额度说明",
      desc: (
        <>
          <p>每次发送消息消耗 <strong>1 次</strong>额度（跨会话累计）。</p>
          <p className="mt-2">额度用完后，可联系分享者增加。</p>
          <p className="mt-2 text-xs text-gray-400">注：探索过程中锁屏或切后台不影响结果——回来会自动恢复进度，不会丢失。</p>
        </>
      ),
    },
  ];

  const current = steps[step];
  const isLast = step === steps.length - 1;

  return (
    <div className="h-dvh flex items-center justify-center bg-gray-50 px-4">
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 w-full max-w-sm p-8 text-center">
        {/* 进度指示 */}
        <div className="flex justify-center gap-1.5 mb-6">
          {steps.map((_, i) => (
            <span
              key={i}
              className={`h-1.5 rounded-full transition-all ${i === step ? "w-6 bg-blue-600" : "w-1.5 bg-gray-300"}`}
            />
          ))}
        </div>

        {/* 步骤图标 */}
        <div className="flex justify-center mb-4">
          <div className="w-16 h-16 rounded-2xl bg-blue-50 flex items-center justify-center text-blue-600">
            {current.icon}
          </div>
        </div>

        <h2 className="text-base font-semibold text-gray-800 mb-3">{current.title}</h2>
        <div className="text-sm text-gray-600 text-left space-y-1 mb-6">{current.desc}</div>

        {/* 按钮 */}
        <div className="flex gap-2">
          {step > 0 && (
            <button
              onClick={() => setStep(step - 1)}
              className="flex-1 px-4 py-2.5 text-sm text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50 font-medium"
            >
              上一步
            </button>
          )}
          {isLast ? (
            <button
              onClick={finish}
              className="flex-1 px-4 py-2.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-medium"
            >
              开始使用
            </button>
          ) : (
            <button
              onClick={() => setStep(step + 1)}
              className="flex-1 px-4 py-2.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-medium"
            >
              下一步
            </button>
          )}
        </div>

        {/* 跳过 */}
        {!isLast && (
          <button onClick={finish} className="mt-3 text-xs text-gray-400 hover:text-gray-600">
            跳过引导
          </button>
        )}
      </div>
    </div>
  );
}
