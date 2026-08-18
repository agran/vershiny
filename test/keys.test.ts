// @vitest-environment jsdom
/**
 * Горячие клавиши панорамы не должны съедать ввод текста.
 *
 * Регресс: слушатель WASD/стрелок висит на `window` и гасит событие. Пока
 * проверки не было, в поиске по карте не набирались слова с буквами w/a/s/d
 * («Washington», «Ushba»), а наблюдатель шагал по 500 м на каждое нажатие;
 * стрелки на ползунках настроек не работали по той же причине.
 */

import { describe, it, expect } from "vitest";
import { isTypingTarget } from "../src/ui/keys";

describe("ввод текста против горячих клавиш", () => {
  it("поле поиска и ползунок настроек — это ввод", () => {
    const input = document.createElement("input");
    const range = document.createElement("input");
    range.type = "range";
    const area = document.createElement("textarea");
    const select = document.createElement("select");

    expect(isTypingTarget(input)).toBe(true);
    expect(isTypingTarget(range)).toBe(true);
    expect(isTypingTarget(area)).toBe(true);
    expect(isTypingTarget(select)).toBe(true);
  });

  it("холст панорамы и пустая цель — не ввод", () => {
    expect(isTypingTarget(document.createElement("canvas"))).toBe(false);
    expect(isTypingTarget(document.body)).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });

  it("contenteditable тоже считается вводом", () => {
    const div = document.createElement("div");
    Object.defineProperty(div, "isContentEditable", { value: true });
    expect(isTypingTarget(div)).toBe(true);
  });
});
