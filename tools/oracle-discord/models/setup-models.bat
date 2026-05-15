@echo off
REM ============================================================
REM  Oracle Sovereign Model Setup
REM  Run this once (or after changing a Modelfile) to bake
REM  bot identities into Ollama at the model level.
REM ============================================================

echo [Oracle/Models] Building Sovereign Fleet...

echo [1/9] Leo-Sovereign
ollama create Leo-Sovereign -f "%~dp0Leo-Sovereign.Modelfile"

echo [2/9] Oracle-Sovereign
ollama create Oracle-Sovereign -f "%~dp0Oracle-Sovereign.Modelfile"

echo [3/9] Claudey-Sovereign
ollama create Claudey-Sovereign -f "%~dp0Claudey-Sovereign.Modelfile"

echo [4/9] Gemini-Sovereign
ollama create Gemini-Sovereign -f "%~dp0Gemini-Sovereign.Modelfile"

echo [5/9] Groq-Sovereign
ollama create Groq-Sovereign -f "%~dp0Groq-Sovereign.Modelfile"

echo [6/9] X-Sovereign
ollama create X-Sovereign -f "%~dp0X-Sovereign.Modelfile"

echo [7/9] Analyst-Sovereign
ollama create Analyst-Sovereign -f "%~dp0Analyst-Sovereign.Modelfile"

echo [8/9] Researcher-Sovereign
ollama create Researcher-Sovereign -f "%~dp0Researcher-Sovereign.Modelfile"

echo [9/9] Kai-Coder-Sovereign
ollama create Kai-Coder-Sovereign -f "%~dp0Kai-Coder-Sovereign.Modelfile"

echo.
echo [Oracle/Models] All 9 Sovereign models registered.
echo Run 'ollama list' to verify.
echo.
echo If a model was previously cached, restart Ollama after this.
pause

