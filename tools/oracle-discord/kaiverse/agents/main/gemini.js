export class Agent {
    constructor(name) {
        this.name = name;
    }

    async handleMessage(message) {
        console.log("[${this.name}] Handling message: ");
    }
}

