import sys
import json
from sympy import sympify, latex, N, simplify

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No equation provided."}))
        sys.exit(1)

    equation_str = sys.argv[1]
    
    # Set a 2-second timeout to avoid taking the PC hostage
    try:
        import threading
        import os

        def exit_after_timeout():
            print(json.dumps({"error": "Computation exceeded 2 seconds timeout. PC Hostage prevention triggered."}))
            os._exit(1)

        timer = threading.Timer(2.0, exit_after_timeout)
        timer.start()

        try:
            # Parse and evaluate
            expr = sympify(equation_str)
            simplified_expr = simplify(expr)
            numeric_val = N(expr)
            latex_expr = latex(simplified_expr)

            result = {
                "simplified": str(simplified_expr),
                "numeric": float(numeric_val) if numeric_val.is_real else str(numeric_val),
                "latex": f"$$ {latex_expr} $$",
                "markdown": f"**Equation:** `{equation_str}`\n\n**Simplified:**\n```math\n{latex_expr}\n```\n\n**Numeric Result:** `{float(numeric_val) if numeric_val.is_real else numeric_val}`"
            }
            print(json.dumps(result))
        except Exception as e:
            print(json.dumps({"error": str(e)}))
        finally:
            timer.cancel()

    except Exception as e:
        print(json.dumps({"error": str(e)}))

if __name__ == "__main__":
    main()
