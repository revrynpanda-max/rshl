#!/usr/bin/env python3
"""
KAI Math Engine v2.0 Test Suite
Tests the expanded rule engine with unit conversions, date math, 
logic operations, and fake math detection.
"""

import json
import urllib.request

KAI_API = "http://127.0.0.1:3334/api/oracle-turn"

def test_kai(question):
    data = json.dumps({"from": "Test", "text": question}).encode()
    req = urllib.request.Request(
        KAI_API,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read())["reply"]
    except Exception as e:
        return f"ERROR: {e}"

def run_tests():
    print("=" * 60)
    print("KAI MATH ENGINE v2.0 - COMPREHENSIVE TEST SUITE")
    print("=" * 60)
    
    tests = [
        # Arithmetic
        ("What is 5 plus 3?", "8"),
        ("What is 10 minus 4?", "6"),
        ("What is 6 times 7?", "42"),
        ("What is 20 divided by 5?", "4"),
        ("What is 5 squared?", "25"),
        
        # Fake Math
        ("What is 5 divided by 0?", "undefined"),
        
        # Percentages
        ("What is 20 percent of 50?", "10"),
        
        # Comparisons
        ("What is 5 greater than 3?", "true"),
        ("What is 2 less than 8?", "true"),
        
        # Boolean Logic
        ("What is true and false?", "false"),
        ("What is true or false?", "true"),
        ("What is true xor true?", "false"),
        ("What is not false?", "true"),
        
        # Unit Conversions
        ("5 meters to feet", "16.4042"),
        ("10 kilometers to miles", "6.21371"),
        ("32 fahrenheit to celsius", "0"),
        ("100 celsius to fahrenheit", "212"),
        ("5 kilograms to pounds", "11.0231"),
        
        # Date Math
        ("days between 2024-01-01 and 2024-01-10", "9"),
    ]
    
    passed = 0
    failed = 0
    
    for question, expected in tests:
        reply = test_kai(question)
        status = "PASS" if expected in reply else "FAIL"
        if status == "PASS":
            passed += 1
        else:
            failed += 1
        print(f"\n[{status}] Q: {question}")
        print(f"       A: {reply}")
        if status == "FAIL":
            print(f"       Expected: {expected}")
    
    print("\n" + "=" * 60)
    print(f"RESULTS: {passed}/{len(tests)} passed, {failed} failed")
    print("=" * 60)

if __name__ == "__main__":
    run_tests()
