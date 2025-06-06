import { useState } from "react";
import { useNavigate } from "react-router-dom";

export default function Login() {
  const [userId, setUserId] = useState("");
  const navigate = useNavigate();

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-100 dark:bg-gray-900 px-4">
      <div className="max-w-md w-full bg-white dark:bg-gray-800 rounded-2xl shadow-lg overflow-hidden">
        {/* Header */}
        <div className="px-8 py-6">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-1">
            Welcome back
          </h1>
          <p className="text-sm text-gray-600 dark:text-gray-300">
            Please log in with your username
          </p>
        </div>

        {/* Form */}
        <form
          className="px-8 pb-8"
          onSubmit={(e) => {
            e.preventDefault();
            if (userId.trim()) {
              navigate(`/chat?userId=${encodeURIComponent(userId.trim())}`);
            }
          }}
        >
          <label
            htmlFor="username"
            className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
          >
            Username
          </label>
          <input
            id="username"
            type="text"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            placeholder="e.g. alice123"
            className="block w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-4 py-2 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent mb-6"
          />

          <button
            type="submit"
            className={`w-full flex justify-center items-center rounded-lg px-4 py-2 text-white font-semibold 
                        ${userId.trim()
                          ? "bg-black hover:bg-gray-800"
                          : "bg-gray-400 cursor-not-allowed"} 
                        focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500`}
            disabled={!userId.trim()}
          >
            Start Chat
          </button>
        </form>
      </div>
    </div>
  );
}
