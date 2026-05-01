from flask import Flask, jsonify

app = Flask(__name__)

@app.route('/')
def hello():
    return jsonify(message="Hello from the KAI Sandbox!")

if __name__ == '__main__':
    app.run(port=5000)
